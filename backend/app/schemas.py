from pydantic import BaseModel
from typing import Any, Dict, Optional, List

class Token(BaseModel):
    access_token: str
    token_type: str

class UserCreate(BaseModel):
    username: str
    password: str
    role: Optional[str] = "user"

class UserOut(BaseModel):
    id: int
    username: str
    role: str

    class Config:
        orm_mode = True

class StateIn(BaseModel):
    state: Dict[str, Any]


# --- Classification related schemas --------------------------------------------------

class Attribute(BaseModel):
    attributeId: str
    description: str
    allowedValues: Optional[List[str]] = []

class ClassificationBase(BaseModel):
    classId: str
    className: str
    attributes: List[Attribute]

class ClassificationCreate(ClassificationBase):
    pass

class ClassificationOut(ClassificationBase):
    id: int

    class Config:
        # Pydantic v2 uses `from_attributes` instead of orm_mode;
        # setting both for compatibility with v1-style code.
        orm_mode = True
        from_attributes = True


class ClassAttributeOut(BaseModel):
    classId: str
    className: str
    attributeId: str
    description: str
    allowedValues: Optional[List[str]] = []
