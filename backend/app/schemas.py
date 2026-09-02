from pydantic import BaseModel
from typing import Any, Dict, Optional, List

class Token(BaseModel):
    access_token: str
    token_type: str
    refresh_token: Optional[str] = None

class UserCreate(BaseModel):
    username: str
    password: str

class UserOut(BaseModel):
    id: int
    username: str
    role: str
    approval_status: str

    class Config:
        orm_mode = True

class UserUpdate(BaseModel):
    role: Optional[str] = None
    approval_status: Optional[str] = None

class StateIn(BaseModel):
    state: Dict[str, Any]


# --- Classification related schemas --------------------------------------------------

class Attribute(BaseModel):
    attributeId: str
    description: str
    unit: Optional[str] = None
    allowedValues: Optional[List[str]] = []
    # Optional per-value descriptions, keyed by allowed value
    valueDescriptions: Optional[Dict[str, str]] = None

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
    unit: Optional[str] = None
    allowedValues: Optional[List[str]] = []
    # Optional per-value descriptions, keyed by allowed value
    valueDescriptions: Optional[Dict[str, str]] = None


# --- Value List related schemas ---------------------------------------------------

class ValueListRowOut(BaseModel):
    id: int
    valuelistId: str
    valuelistIdDescription: Optional[str] = None
    unit: Optional[str] = None
    value: str
    valueDescription: Optional[str] = None

    class Config:
        orm_mode = True
        from_attributes = True

class ValueListRowCreate(BaseModel):
    valuelistId: str
    valuelistIdDescription: Optional[str] = None
    unit: Optional[str] = None
    value: str
    valueDescription: Optional[str] = None

class ValueListGroupOut(BaseModel):
    valuelistId: str
    valuelistIdDescription: Optional[str] = None
    unit: Optional[str] = None
    valueCount: int


# --- Item Class Attribute Value schemas -------------------------------------------

class ClassAttributeValuesIn(BaseModel):
    classId: str
    previousClassId: Optional[str] = None
    values: Dict[str, str]
