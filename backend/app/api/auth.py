import time
from collections import defaultdict
from datetime import timedelta
from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from ..db import models
from ..db.session import get_db
from ..schemas import UserCreate, Token, UserOut, UserUpdate
from passlib.context import CryptContext
from ..core.security import (
    create_access_token,
    create_refresh_token,
    get_current_user,
    oauth2_scheme,
    blacklist_token,
    ALGORITHM,
    REFRESH_TOKEN_EXPIRE_DAYS,
)
from ..core.config import settings

try:
    import redis as _redis_lib
except ImportError:  # redis is optional; falls back to in-process limiting
    _redis_lib = None

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "refresh_token"
REFRESH_COOKIE_PATH = "/auth"

# --- Rate limiter for auth endpoints (Redis-backed when configured) ---
_login_attempts: dict = defaultdict(list)  # key -> [timestamp, ...]
_RATE_LIMIT_WINDOW = 60  # seconds
_RATE_LIMIT_MAX = 5  # max attempts per window
_redis_client = None


def _get_redis():
    global _redis_client
    if not settings.REDIS_URL or _redis_lib is None:
        return None
    if _redis_client is None:
        _redis_client = _redis_lib.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis_client


def _client_ip(request: Request) -> str:
    if settings.TRUST_PROXY_HEADERS:
        xff = request.headers.get("x-forwarded-for", "")
        if xff:
            return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_rate_limit(request: Request, username: str = ""):
    key = f"{_client_ip(request)}|{(username or '').strip().lower()}"
    r = _get_redis()
    if r is not None:
        redis_key = f"login:{key}"
        count = r.incr(redis_key)
        if count == 1:
            r.expire(redis_key, _RATE_LIMIT_WINDOW)
        if count > _RATE_LIMIT_MAX:
            raise HTTPException(
                status_code=429,
                detail=f"Too many login attempts. Try again in {_RATE_LIMIT_WINDOW} seconds.",
            )
        return

    now = time.time()
    bucket = [t for t in _login_attempts[key] if now - t < _RATE_LIMIT_WINDOW]
    if len(bucket) >= _RATE_LIMIT_MAX:
        _login_attempts[key] = bucket
        raise HTTPException(
            status_code=429,
            detail=f"Too many login attempts. Try again in {_RATE_LIMIT_WINDOW} seconds.",
        )
    bucket.append(now)
    _login_attempts[key] = bucket
    # Bound memory: drop keys whose window has fully expired.
    if len(_login_attempts) > 10000:
        for k in [k for k, v in _login_attempts.items() if not v]:
            _login_attempts.pop(k, None)


def _set_refresh_cookie(response: Response, token: str, request: Request):
    # Secure only over HTTPS so http/LAN deployments still receive the cookie;
    # behind a TLS proxy with --proxy-headers the scheme is https and it turns on.
    secure = settings.COOKIE_SECURE and request.url.scheme == "https"
    response.set_cookie(
        key=REFRESH_COOKIE,
        value=token,
        httponly=True,
        secure=secure,
        samesite=settings.COOKIE_SAMESITE,
        path=REFRESH_COOKIE_PATH,
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 24 * 3600,
    )


def verify_password(plain, hashed):
    return pwd_context.verify(plain, hashed)


def get_password_hash(password):
    return pwd_context.hash(password)


@router.post("/register", response_model=UserOut)
def register(user_in: UserCreate, request: Request, db: Session = Depends(get_db)):
    _check_rate_limit(request, user_in.username)
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
def login(request: Request, response: Response, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    _check_rate_limit(request, form_data.username)
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
    # Refresh token is delivered only as an HttpOnly cookie, out of reach of page script.
    _set_refresh_cookie(response, refresh_token, request)
    return {"access_token": access_token, "token_type": "bearer"}


@router.post("/logout")
def logout(response: Response, token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    blacklist_token(token, db)
    response.delete_cookie(REFRESH_COOKIE, path=REFRESH_COOKIE_PATH)
    return {"ok": True}


@router.post("/refresh")
def refresh_token(request: Request, response: Response, body: dict = Body(default={}), db: Session = Depends(get_db)):
    """Exchange a valid refresh token (from the HttpOnly cookie) for a new pair (rotation)."""
    refresh = request.cookies.get(REFRESH_COOKIE) or (body or {}).get("refresh_token")
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

    # Verify user still exists and is still approved (revoked accounts cannot rotate).
    user = db.query(models.User).filter(models.User.username == username).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    if getattr(user, "approval_status", "approved") != "approved":
        raise HTTPException(status_code=401, detail="Account is not active")

    # Blacklist the old refresh token (rotation — each refresh token is single-use)
    if not blacklist_token(refresh, db):
        # Another concurrent request already consumed this refresh token
        raise HTTPException(status_code=401, detail="Refresh token already used")

    # Issue new pair
    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    new_access = create_access_token(data={"sub": username}, expires_delta=access_token_expires)
    new_refresh = create_refresh_token(data={"sub": username})
    _set_refresh_cookie(response, new_refresh, request)
    return {"access_token": new_access, "token_type": "bearer"}


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

