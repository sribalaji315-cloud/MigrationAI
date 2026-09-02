import time
from collections import defaultdict
from datetime import timedelta
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from ..db import models
from ..db.session import get_db
from ..schemas import UserCreate, Token, UserOut, UserUpdate
from passlib.context import CryptContext
from ..core.security import create_access_token, create_refresh_token, get_current_user, oauth2_scheme, blacklist_token, ALGORITHM
from ..core.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
router = APIRouter(prefix="/auth", tags=["auth"])

# --- In-memory rate limiter for auth endpoints ---
_login_attempts: dict = defaultdict(list)  # ip -> [timestamp, ...]
_RATE_LIMIT_WINDOW = 60  # seconds
_RATE_LIMIT_MAX = 5  # max attempts per window


def _check_rate_limit(request: Request):
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    # Prune old entries
    _login_attempts[ip] = [t for t in _login_attempts[ip] if now - t < _RATE_LIMIT_WINDOW]
    if len(_login_attempts[ip]) >= _RATE_LIMIT_MAX:
        raise HTTPException(
            status_code=429,
            detail=f"Too many login attempts. Try again in {_RATE_LIMIT_WINDOW} seconds."
        )
    _login_attempts[ip].append(now)


def verify_password(plain, hashed):
    return pwd_context.verify(plain, hashed)


def get_password_hash(password):
    return pwd_context.hash(password)


@router.post("/register", response_model=UserOut)
def register(user_in: UserCreate, request: Request, db: Session = Depends(get_db)):
    _check_rate_limit(request)
    user = db.query(models.User).filter(models.User.username == user_in.username).first()
    if user:
        raise HTTPException(status_code=400, detail="Username already registered")
    # Role is never taken from the request; new accounts are always plain users.
    user = models.User(
        username=user_in.username, 
        password_hash=get_password_hash(user_in.password), 
        role="user",
        approval_status="pending"
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=Token)
def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    _check_rate_limit(request)
    user = db.query(models.User).filter(models.User.username == form_data.username).first()
    if not user or not verify_password(form_data.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    
    if user.approval_status != "approved":
        if user.approval_status == "rejected":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account has been rejected")
        else:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account pending admin approval")
            
    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(data={"sub": user.username}, expires_delta=access_token_expires)
    refresh_token = create_refresh_token(data={"sub": user.username})
    return {"access_token": access_token, "token_type": "bearer", "refresh_token": refresh_token}


@router.post("/logout")
def logout(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    blacklist_token(token, db)
    return {"ok": True}


@router.post("/refresh")
def refresh_token(body: dict, db: Session = Depends(get_db)):
    """Exchange a valid refresh token for a new access + refresh token pair (rotation)."""
    refresh = body.get("refresh_token")
    if not refresh:
        raise HTTPException(status_code=400, detail="refresh_token required")
    from jose import jwt, JWTError
    try:
        payload = jwt.decode(refresh, settings.SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") != "refresh":
            raise HTTPException(status_code=401, detail="Invalid token type")
        username = payload.get("sub")
        jti = payload.get("jti")
        if not username:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    # Check if this refresh token was already used (blacklisted)
    if jti:
        blacklisted = db.query(models.TokenBlacklist).filter(models.TokenBlacklist.jti == jti).first()
        if blacklisted:
            raise HTTPException(status_code=401, detail="Refresh token already used")

    # Verify user still exists
    user = db.query(models.User).filter(models.User.username == username).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Blacklist the old refresh token (rotation — each refresh token is single-use)
    if not blacklist_token(refresh, db):
        # Another concurrent request already consumed this refresh token
        raise HTTPException(status_code=401, detail="Refresh token already used")

    # Issue new pair
    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    new_access = create_access_token(data={"sub": username}, expires_delta=access_token_expires)
    new_refresh = create_refresh_token(data={"sub": username})
    return {"access_token": new_access, "token_type": "bearer", "refresh_token": new_refresh}


@router.get("/me", response_model=UserOut)
def me(current_user: models.User = Depends(get_current_user)):
    return current_user


@router.get("/users", response_model=list[UserOut])
def get_users(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin privileges required")
    return db.query(models.User).all()


@router.put("/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, user_update: UserUpdate, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin privileges required")
    
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        
    if user_update.role is not None:
        user.role = user_update.role
    if user_update.approval_status is not None:
        user.approval_status = user_update.approval_status
        
    db.commit()
    db.refresh(user)
    return user


@router.delete("/users/{user_id}")
def delete_user(user_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin privileges required")
        
    if current_user.id == user_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete your own account")
        
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        
    db.delete(user)
    db.commit()
    return {"detail": "User deleted successfully"}

