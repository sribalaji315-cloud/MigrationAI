from sqlalchemy import Column, Integer, JSON, String
from .session import Base

class AppState(Base):
    __tablename__ = "app_state"
    id = Column(Integer, primary_key=True, index=True)
    state = Column(JSON, nullable=True)

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role = Column(String, default="user")


class Classification(Base):
    __tablename__ = "classifications"
    id = Column(Integer, primary_key=True, index=True)
    class_id = Column(String, unique=True, index=True, nullable=False)
    class_name = Column(String, nullable=False)
    # attributes is a list of objects describing each attribute; stored as JSON for flexibility
    attributes = Column(JSON, nullable=True)
