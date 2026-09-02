import time
import uuid
import hmac
import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, APIKeyHeader
from jose import jwt, JWTError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import settings
from ..db import models
from ..db.session import get_db

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

# External integrations authenticate by sending their key in the X-API-Key
# header. auto_error=False lets us return a clearer error message ourselves.
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

ALGORITHM = "HS256"
REFRESH_TOKEN_EXPIRE_DAYS = 7


def hash_api_key(key: str) -> str:
    """Return the SHA-256 hex digest used to store/look up an API key."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def generate_api_key() -> str:
    """Generate a new random API key (URL-safe, high entropy)."""
    return secrets.token_urlsafe(32)




def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire, "jti": uuid.uuid4().hex, "type": "access"})
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def create_refresh_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire, "jti": uuid.uuid4().hex, "type": "refresh"})
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        jti: str = payload.get("jti")
        if username is None:
            raise credentials_exception
        # Only access tokens authorise API calls; refresh tokens are rejected here.
        if payload.get("type") != "access":
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    # Check token blacklist (revoked tokens)
    if jti:
        blacklisted = db.query(models.TokenBlacklist).filter(models.TokenBlacklist.jti == jti).first()
        if blacklisted:
            raise credentials_exception

    user = db.query(models.User).filter(models.User.username == username).first()
    if user is None:
        raise credentials_exception
    # A revoked/pending account must lose access immediately, not only at next login.
    if getattr(user, "approval_status", "approved") != "approved":
        raise credentials_exception
    return user


def get_user_from_token(token: str, db: Session):
    """Validate a raw access-token string (e.g. from a WebSocket query param).

    Returns the user when the token is a valid, non-blacklisted access token for
    an approved account; otherwise None. Never raises.
    """
    if not token:
        return None
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None
    if payload.get("type") != "access":
        return None
    username = payload.get("sub")
    jti = payload.get("jti")
    if not username:
        return None
    if jti and db.query(models.TokenBlacklist).filter(models.TokenBlacklist.jti == jti).first():
        return None
    user = db.query(models.User).filter(models.User.username == username).first()
    if user is None or getattr(user, "approval_status", "approved") != "approved":
        return None
    return user


def require_api_key(
    api_key: Optional[str] = Depends(api_key_header),
    db: Session = Depends(get_db),
) -> str:
    """Authenticate an external caller via the X-API-Key header.

    Accepts keys from two sources:
      1. Static keys in the ``PUBLIC_API_KEYS`` env setting (compared in
         constant time).
      2. Keys issued via the admin API and stored (hashed) in the ``api_keys``
         table.

    Returns the validated key on success. Raises 503 when the public API is
    disabled (no static keys and no active stored keys) and 401 when the key is
    missing or invalid.
    """
    configured = settings.get_public_api_keys()
    has_db_keys = (
        db.query(models.ApiKey).filter(models.ApiKey.revoked == 0).first() is not None
    )
    if not configured and not has_db_keys:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Public API is not enabled on this server.",
        )
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing API key. Provide it in the 'X-API-Key' header.",
            headers={"WWW-Authenticate": "X-API-Key"},
        )

    # 1. Static env keys (constant-time compare).
    for valid in configured:
        if hmac.compare_digest(api_key, valid):
            return api_key

    # 2. Stored keys (lookup by SHA-256 hash).
    key_hash = hash_api_key(api_key)
    record = (
        db.query(models.ApiKey)
        .filter(models.ApiKey.key_hash == key_hash, models.ApiKey.revoked == 0)
        .first()
    )
    if record is not None:
        now = time.time()
        # Throttle last_used writes to at most once per minute per key.
        if not record.last_used_at or (now - record.last_used_at) > 60:
            record.last_used_at = now
            try:
                db.commit()
            except Exception:
                db.rollback()
        return api_key

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid API key.",
        headers={"WWW-Authenticate": "X-API-Key"},
    )


def blacklist_token(token: str, db: Session) -> bool:
    """Add a token's jti to the blacklist so it can no longer be used.

    Returns True if the token was newly blacklisted, False if it was already
    blacklisted (duplicate). Raises nothing on race conditions."""
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
        jti = payload.get("jti")
        exp = payload.get("exp", 0)
        if jti:
            entry = models.TokenBlacklist(jti=jti, expires_at=float(exp))
            db.add(entry)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                return False
    except JWTError:
        pass
    return True


def cleanup_expired_blacklist(db: Session):
    """Remove expired tokens from the blacklist to prevent unbounded growth."""
    now = time.time()
    db.query(models.TokenBlacklist).filter(models.TokenBlacklist.expires_at < now).delete()
    db.commit()
