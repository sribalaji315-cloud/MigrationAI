from pathlib import Path
from typing import List
from pydantic_settings import BaseSettings


def _default_database_url() -> str:
    # Always resolve to backend/dev.db regardless of current working directory.
    backend_root = Path(__file__).resolve().parents[2]
    db_path = (backend_root / "dev.db").as_posix()
    return f"sqlite:///{db_path}"

class Settings(BaseSettings):
    DATABASE_URL: str = _default_database_url()
    SECRET_KEY: str = ""
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    ALLOWED_ORIGINS: str = "http://localhost:3000,http://localhost:5173"
    ALLOWED_ORIGIN_REGEX: str = r"^https?://(localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(:\d+)?$"
    ADMIN_EMAIL: str = ""
    ADMIN_PASSWORD: str = ""

    class Config:
        env_file = ".env"

    def get_allowed_origins(self) -> List[str]:
        return [o.strip() for o in self.ALLOWED_ORIGINS.split(",") if o.strip()]

settings = Settings()
if not settings.SECRET_KEY or settings.SECRET_KEY == "change-me":
    import os
    env_key = os.environ.get("SECRET_KEY", "")
    if not env_key or env_key == "change-me":
        raise RuntimeError(
            "SECRET_KEY must be set via environment variable or .env file. "
            "Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(64))\""
        )
