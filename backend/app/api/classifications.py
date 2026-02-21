from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import List

from ..db import models
from ..db.session import get_db
from ..schemas import ClassificationCreate, ClassificationOut
from ..core.security import get_current_user

router = APIRouter(tags=["classifications"])

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

