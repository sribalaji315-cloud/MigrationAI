
import logging
import time
import uuid

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from .api import auth, state, classifications, valuelists, ml, imports
from .api import public
from .api.websocket import manager
from .db.session import engine, Base, SessionLocal
from .db import models
from .core.config import settings
from .core.security import cleanup_expired_blacklist, get_user_from_token

# --- Structured logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("erp_migrator")

# We no longer use Base.metadata.create_all(bind=engine) because we use Alembic for migrations.
# Base.metadata.create_all(bind=engine)

app = FastAPI(title="ERP Data Migrator Backend")

app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.get_allowed_origins(),
    allow_origin_regex=settings.ALLOWED_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(state.router)
app.include_router(classifications.router)
app.include_router(valuelists.router)
app.include_router(ml.router)
app.include_router(imports.router)
app.include_router(public.router)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request_id = uuid.uuid4().hex[:12]
    request.state.request_id = request_id
    start = time.time()
    response = await call_next(request)
    duration_ms = (time.time() - start) * 1000
    logger.info(
        "req=%s method=%s path=%s status=%s duration=%.1fms",
        request_id,
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
    )
    response.headers["X-Request-ID"] = request_id
    return response


@app.get("/")
def root():
    return {"ok": True}


@app.get("/health")
def health():
    return {"ok": True}


@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    """WebSocket endpoint for real-time collaboration events.

    The access token must be supplied as a ``?token=`` query parameter; the
    connection identity is derived from the verified token, not the URL path.
    """
    token = websocket.query_params.get("token", "")
    db = SessionLocal()
    try:
        user = get_user_from_token(token, db)
    finally:
        db.close()
    if user is None:
        await websocket.close(code=1008)  # policy violation
        return

    verified_client_id = f"USR-{user.id}"
    await manager.connect(websocket, verified_client_id)
    try:
        while True:
            # Keep connection alive; clients can send pings
            data = await websocket.receive_text()
            # Echo pong for keepalive
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        await manager.disconnect(verified_client_id, websocket)


@app.on_event("startup")
def ensure_admin_user():
    """Seed an admin user from ADMIN_EMAIL / ADMIN_PASSWORD env vars if no admin exists."""
    db = SessionLocal()
    try:
        admin = db.query(models.User).filter(models.User.role == 'admin').first()
        if not admin and settings.ADMIN_EMAIL and settings.ADMIN_PASSWORD:
            from passlib.context import CryptContext
            pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
            admin_user = models.User(
                username=settings.ADMIN_EMAIL,
                password_hash=pwd.hash(settings.ADMIN_PASSWORD),
                role="admin",
                approval_status="approved"
            )
            db.add(admin_user)
            db.commit()
            logger.info("Created admin user from ADMIN_EMAIL env var")
        elif not admin:
            logger.warning(
                "No admin user exists and ADMIN_EMAIL/ADMIN_PASSWORD env vars are not set. "
                "Set them to create the initial admin account."
            )
        # Cleanup expired blacklisted tokens on startup
        cleanup_expired_blacklist(db)
    finally:
        db.close()
