
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .api import auth, state, classifications
from .db.session import engine, Base, SessionLocal
from .db import models
from .core.config import settings

# Create DB tables (dev convenience)
Base.metadata.create_all(bind=engine)

app = FastAPI(title="ERP Data Migrator Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(state.router)
app.include_router(classifications.router)

@app.get("/")
def root():
    return {"ok": True}


@app.on_event("startup")
def ensure_admin_user():
    # create a default admin user if none exist (useful for local dev)
    db = SessionLocal()
    try:
        admin = db.query(models.User).filter(models.User.role == 'admin').first()
        if not admin:
            # create a simple admin; password should be changed in production
            from passlib.context import CryptContext
            pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
            admin_user = models.User(username="admin", password_hash=pwd.hash("admin"), role="admin")
            db.add(admin_user)
            db.commit()
    finally:
        db.close()
