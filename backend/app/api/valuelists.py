"""CRUD and paginated endpoints for the value_list table."""

import csv
import io
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..core.security import get_current_user
from ..db import models
from ..db.session import get_db
from ..schemas import ValueListGroupOut, ValueListRowCreate, ValueListRowOut

router = APIRouter(tags=["valuelists"])


# ---------------------------------------------------------------------------
# Paginated listing (grouped by valuelist_id)
# ---------------------------------------------------------------------------

@router.get("/valuelists/paginated")
def list_valuelists_paginated(
    search: Optional[str] = None,
    limit: int = Query(20, ge=0, le=5000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    """Return paginated value-list groups with value counts."""

    base = db.query(
        models.ValueList.valuelist_id,
        func.min(models.ValueList.valuelist_id_description).label("description"),
        func.min(models.ValueList.unit).label("unit"),
        func.count(models.ValueList.id).label("cnt"),
    ).group_by(models.ValueList.valuelist_id)

    if search:
        like = f"%{search}%"
        base = base.having(
            or_(
                models.ValueList.valuelist_id.ilike(like),
                func.min(models.ValueList.valuelist_id_description).ilike(like),
            )
        )

    # Total distinct valuelist_ids matching the filter
    total = base.count()

    rows = (
        base
        .order_by(models.ValueList.valuelist_id)
        .offset(offset)
        .limit(limit)
        .all()
    )

    items = [
        {
            "valuelistId": r.valuelist_id,
            "valuelistIdDescription": r.description or "",
            "unit": r.unit or "",
            "valueCount": r.cnt,
        }
        for r in rows
    ]

    return {"items": items, "total": total}


# ---------------------------------------------------------------------------
# Filters (cross-filtering for dropdowns)
# ---------------------------------------------------------------------------

@router.get("/valuelists/filters")
def get_valuelist_filters(
    valuelistId: Optional[str] = None,
    value: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Return distinct valuelist IDs and values with bidirectional cross-filtering."""

    query = db.query(models.ValueList)

    if valuelistId:
        query = query.filter(models.ValueList.valuelist_id == valuelistId)
    if value:
        target = value.strip().lower()
        query = query.filter(func.lower(models.ValueList.value) == target)

    all_rows = query.all()

    vlid_set: dict = {}
    value_set: set = set()
    for r in all_rows:
        if r.valuelist_id not in vlid_set:
            vlid_set[r.valuelist_id] = r.valuelist_id_description or ""
        value_set.add(r.value)

    valuelist_options = [
        {"valuelistId": k, "valuelistIdDescription": v}
        for k, v in sorted(vlid_set.items(), key=lambda x: x[0].lower())
    ]
    value_options = sorted(value_set, key=str.lower)

    return {"valuelists": valuelist_options, "values": value_options}


# ---------------------------------------------------------------------------
# Detail: all rows for a single valuelist_id
# ---------------------------------------------------------------------------

@router.get("/valuelists/{valuelist_id}", response_model=List[ValueListRowOut])
def get_valuelist_detail(valuelist_id: str, db: Session = Depends(get_db)):
    rows = (
        db.query(models.ValueList)
        .filter(models.ValueList.valuelist_id == valuelist_id)
        .order_by(models.ValueList.value)
        .all()
    )
    if not rows:
        raise HTTPException(status_code=404, detail="value list not found")
    return [
        ValueListRowOut(
            id=r.id,
            valuelistId=r.valuelist_id,
            valuelistIdDescription=r.valuelist_id_description or "",
            unit=r.unit or "",
            value=r.value,
            valueDescription=r.value_description or "",
        )
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Bulk replace (admin only)
# ---------------------------------------------------------------------------

@router.post("/valuelists/bulk")
def bulk_replace_valuelists(
    payload: List[ValueListRowCreate],
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="admin role required")

    try:
        db.query(models.ValueList).delete()
        records = [
            models.ValueList(
                valuelist_id=row.valuelistId,
                valuelist_id_description=row.valuelistIdDescription,
                unit=row.unit,
                value=row.value,
                value_description=row.valueDescription,
            )
            for row in payload
        ]
        db.add_all(records)
        db.commit()
        return {"ok": True, "rowsInserted": len(records)}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Error saving value lists: {str(e)}")


# ---------------------------------------------------------------------------
# CSV upload (admin only) — server-side parsing for data seeding
# ---------------------------------------------------------------------------

@router.post("/valuelists/upload-csv")
async def upload_valuelist_csv(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="admin role required")

    content = await file.read()
    text = content.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))

    records: list = []
    for row in reader:
        vid = (row.get("valuelistId") or row.get("valuelist_id") or "").strip()
        if not vid:
            continue
        val = (row.get("value") or "").strip()
        if not val:
            continue
        records.append(
            models.ValueList(
                valuelist_id=vid,
                valuelist_id_description=(row.get("valuelistIdDescription") or row.get("valuelist_id_description") or "").strip(),
                unit=(row.get("unit") or "").strip() or None,
                value=val,
                value_description=(row.get("valueDescription") or row.get("value_description") or "").strip(),
            )
        )

    if not records:
        raise HTTPException(status_code=400, detail="No valid rows found in CSV")

    try:
        db.add_all(records)
        db.commit()
        return {"ok": True, "rowsInserted": len(records)}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Error importing CSV: {str(e)}")


# ---------------------------------------------------------------------------
# Delete all rows for a valuelist_id (admin only)
# ---------------------------------------------------------------------------

@router.delete("/valuelists/{valuelist_id}")
def delete_valuelist(
    valuelist_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="admin role required")

    count = db.query(models.ValueList).filter(models.ValueList.valuelist_id == valuelist_id).delete()
    db.commit()
    if count == 0:
        raise HTTPException(status_code=404, detail="value list not found")
    return {"ok": True, "rowsDeleted": count}
