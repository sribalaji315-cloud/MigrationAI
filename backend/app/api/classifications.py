from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import List

from ..db import models
from ..db.session import get_db
from ..schemas import ClassificationCreate, ClassificationOut, ClassAttributeOut
from ..core.security import get_current_user

router = APIRouter(tags=["classifications"])


def _normalize_key(value: str) -> str:
    return (value or "").strip().lower()

@router.get("/classifications", response_model=List[ClassificationOut])
def list_classifications(db: Session = Depends(get_db)):
    """Return all classifications stored in the dedicated table."""
    records = db.query(models.Classification).all()
    # map SQL fields to camel-case keys for JSON output
    return [
        ClassificationOut(
            id=r.id,
            classId=r.class_id,
            className=r.class_name,
            attributes=r.attributes or []
        )
        for r in records
    ]


@router.get("/classifications/{class_id}/attributes/{attribute_id}", response_model=ClassAttributeOut)
def get_class_attribute(class_id: str, attribute_id: str, db: Session = Depends(get_db)):
    record = db.query(models.Classification).filter(models.Classification.class_id == class_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="classification not found")

    attrs = record.attributes or []
    target_key = _normalize_key(attribute_id)
    matched = [a for a in attrs if _normalize_key(a.get("attributeId", "")) == target_key]
    if not matched:
        raise HTTPException(status_code=404, detail="attribute not found")

    description = ""
    values: List[str] = []
    seen_values = set()
    for attr in matched:
        if not description:
            description = attr.get("description", "") or ""
        for v in (attr.get("allowedValues") or []):
            val = str(v).strip()
            key = _normalize_key(val)
            if val and key not in seen_values:
                seen_values.add(key)
                values.append(val)

    return ClassAttributeOut(
        classId=record.class_id,
        className=record.class_name,
        attributeId=matched[0].get("attributeId", attribute_id),
        description=description or attribute_id,
        allowedValues=values,
    )


@router.post("/classifications", response_model=ClassificationOut)
def create_classification(
    payload: ClassificationCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Only admins may create a new classification record."""
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="admin role required to add classifications")

    # ensure unique classId
    existing = db.query(models.Classification).filter(models.Classification.class_id == payload.classId).first()
    if existing:
        raise HTTPException(status_code=400, detail="classification with this classId already exists")

    # convert pydantic models to plain dictionaries so JSON column can serialize
    record = models.Classification(
        class_id=payload.classId,
        class_name=payload.className,
        attributes=[attr.dict() for attr in payload.attributes],
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return ClassificationOut.from_orm(record)


@router.post("/classifications/bulk")
def bulk_replace_classifications(
    payload: List[ClassificationCreate],
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Admin only: replace entire set of classifications with supplied list. Used by the front-end sync logic."""
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="admin role required to update classifications")

    try:
        # delete all existing records
        db.query(models.Classification).delete()
        for cls in payload:
            record = models.Classification(
                class_id=cls.classId,
                class_name=cls.className,
                attributes=[attr.dict() for attr in cls.attributes],
            )
            db.add(record)
        db.commit()
        return {"ok": True}
    except IntegrityError as e:
        db.rollback()
        if "unique constraint" in str(e).lower():
            raise HTTPException(status_code=400, detail="Duplicate classId detected. Please ensure all class IDs are unique.")
        raise HTTPException(status_code=400, detail=f"Database error: {str(e)}")
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Error saving classifications: {str(e)}")

