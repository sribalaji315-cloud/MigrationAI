from pathlib import Path
from pydantic_settings import BaseSettings


def _default_database_url() -> str:
    # Always resolve to backend/dev.db regardless of current working directory.
    backend_root = Path(__file__).resolve().parents[2]
    db_path = (backend_root / "dev.db").as_posix()
    return f"sqlite:///{db_path}"

class Settings(BaseSettings):
    DATABASE_URL: str = _default_database_url()
    SECRET_KEY: str = "change-me"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60

    class Config:
        env_file = ".env"

settings = Settings()
