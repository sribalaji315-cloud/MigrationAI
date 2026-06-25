"""Public, read-only product-mapping API for external integrations.

All endpoints are versioned under /api/v1 and authenticated with an API key
sent in the ``X-API-Key`` request header. Configure allowed keys via the
``PUBLIC_API_KEYS`` environment variable (comma-separated).

These endpoints expose the same source -> target mapping data (including
condition, feasibility and value status) that the in-app Product Viewer shows.
"""
import io
import csv
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session, selectinload

from ..db import models
from ..db.session import get_db
from ..core.security import (
    require_api_key,
    get_current_user,
    generate_api_key,
    hash_api_key,
)
from .state import (
    _validate_search,
    _apply_bom_category_filter,
    _apply_bom_product_type_filter,
    _apply_bom_priority_filter,
    _audit,
)

router = APIRouter(prefix="/api/v1", tags=["public-api"])

# CSV column order shared by the export endpoints. Matches the Product Viewer.
CSV_COLUMNS = [
    "Item ID",
    "Description",
    "Legacy Attribute",
    "Legacy Value",
    "Target Attribute",
    "Target Value",
    "Attribute Type",
    "Condition",
    "Feasibility",
    "Value Status",
]


def _item_summary(item: models.BomItem) -> dict:
    return {
        "itemId": item.item_id,
        "description": item.description or "",
        "category": item.category or "",
        "productType": item.product_type or "",
        "priority": item.priority,
        "classification": item.classification or "",
    }


@router.get("/products")
def list_products(
    search: Optional[str] = Query(None, description="Match against item id or description"),
    category: Optional[str] = Query(None),
    productType: Optional[str] = Query(None),
    priority: Optional[int] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _api_key: str = Depends(require_api_key),
):
    """List/search products (BOM items) available for mapping lookups."""
    search = _validate_search(search)
    query = db.query(models.BomItem)
    query = _apply_bom_category_filter(query, category)
    query = _apply_bom_product_type_filter(query, productType)
    query = _apply_bom_priority_filter(query, priority)
    if search:
        like = f"%{search}%"
        query = query.filter(
            or_(models.BomItem.item_id.ilike(like), models.BomItem.description.ilike(like))
        )
    total = query.count()
    items = (
        query.order_by(models.BomItem.item_id)
        .offset(offset)
        .limit(limit)
        .all()
    )
    return {
        "items": [_item_summary(i) for i in items],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


def _build_mapping_rows(item_id: str, db: Session):
    """Return ordered workspace-mapping rows for an item or None if not found."""
    item = (
        db.query(models.BomItem)
        .options(selectinload(models.BomItem.features))
        .filter(models.BomItem.item_id == item_id)
        .first()
    )
    if not item:
        return None, None

    desc_by_feature = {f.feature_id: (f.description or "") for f in item.features}

    rows = (
        db.query(models.WorkspaceMapping)
        .filter(models.WorkspaceMapping.legacy_item_id == item_id)
        .order_by(
            models.WorkspaceMapping.legacy_feature_id,
            models.WorkspaceMapping.legacy_value,
        )
        .all()
    )
    return item, [(row, desc_by_feature.get(row.legacy_feature_id, "")) for row in rows]


@router.get("/products/{item_id}/mappings")
def get_product_mappings(
    item_id: str,
    db: Session = Depends(get_db),
    _api_key: str = Depends(require_api_key),
):
    """Return source -> target mappings for a product, grouped by legacy feature.

    Each value mapping includes its condition, feasibility and value status.
    """
    item, rows = _build_mapping_rows(item_id, db)
    if item is None:
        raise HTTPException(status_code=404, detail=f"Product '{item_id}' not found.")

    features: list[dict] = []
    index_by_feature: dict[str, int] = {}
    for row, feature_desc in rows:
        fid = row.legacy_feature_id
        if fid not in index_by_feature:
            index_by_feature[fid] = len(features)
            features.append({
                "legacyFeatureId": fid,
                "description": feature_desc,
                "attributeType": (row.attribute_type or "").strip(),
                "mappings": [],
            })
        features[index_by_feature[fid]]["mappings"].append({
            "legacyValue": row.legacy_value or "",
            "targetAttribute": row.new_attribute_id or "",
            "targetValue": row.new_value or "",
            "condition": (row.condition or "").strip() or None,
            "feasibility": row.feasibility,
            "valueStatus": row.value_status,
        })

    summary = _item_summary(item)
    summary["features"] = features
    return summary


@router.get("/products/{item_id}/mappings.csv")
def get_product_mappings_csv(
    item_id: str,
    db: Session = Depends(get_db),
    _api_key: str = Depends(require_api_key),
):
    """Return the product's mappings as a downloadable CSV (Product Viewer format)."""
    item, rows = _build_mapping_rows(item_id, db)
    if item is None:
        raise HTTPException(status_code=404, detail=f"Product '{item_id}' not found.")

    def iter_rows():
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(CSV_COLUMNS)
        yield output.getvalue()
        output.seek(0)
        output.truncate(0)

        for row, _feature_desc in rows:
            writer.writerow([
                item.item_id,
                item.description or "",
                row.legacy_feature_id or "",
                row.legacy_value or "",
                row.new_attribute_id or "",
                row.new_value or "",
                (row.attribute_type or "").strip(),
                (row.condition or "").strip(),
                row.feasibility or "",
                row.value_status or "",
            ])
            yield output.getvalue()
            output.seek(0)
            output.truncate(0)

    headers = {"Content-Disposition": f'attachment; filename="product-{item.item_id}.csv"'}
    return StreamingResponse(iter_rows(), media_type="text/csv", headers=headers)


# ---------------------------------------------------------------------------
# API key management (admin only — authenticated with a JWT, not an API key).
# ---------------------------------------------------------------------------

class ApiKeyCreate(BaseModel):
    label: Optional[str] = None


def _require_admin(current_user: models.User = Depends(get_current_user)) -> models.User:
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="admin role required")
    return current_user


def _api_key_out(record: models.ApiKey) -> dict:
    return {
        "id": record.id,
        "prefix": record.prefix,
        "label": record.label or "",
        "createdBy": record.created_by,
        "createdAt": record.created_at,
        "lastUsedAt": record.last_used_at,
        "revoked": bool(record.revoked),
    }


@router.post("/admin/api-keys")
def create_api_key(
    body: ApiKeyCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(_require_admin),
):
    """Issue a new API key. The plaintext key is returned ONCE — store it now."""
    plaintext = generate_api_key()
    record = models.ApiKey(
        key_hash=hash_api_key(plaintext),
        prefix=plaintext[:8],
        label=(body.label or "").strip() or None,
        created_by=getattr(current_user, "username", None),
        created_at=time.time(),
        revoked=0,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    _audit(db, current_user, "create-api-key", f"id={record.id} prefix={record.prefix} label={record.label}")
    result = _api_key_out(record)
    # Plaintext is only ever exposed here, never stored or returned again.
    result["key"] = plaintext
    return result


@router.get("/admin/api-keys")
def list_api_keys(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(_require_admin),
):
    """List issued API keys (metadata only — never the secret value)."""
    records = db.query(models.ApiKey).order_by(models.ApiKey.created_at.desc()).all()
    return {"items": [_api_key_out(r) for r in records]}


@router.delete("/admin/api-keys/{key_id}")
def revoke_api_key(
    key_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(_require_admin),
):
    """Revoke (disable) an API key. The key can no longer authenticate."""
    record = db.query(models.ApiKey).filter(models.ApiKey.id == key_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail=f"API key {key_id} not found.")
    if not record.revoked:
        record.revoked = 1
        db.commit()
        _audit(db, current_user, "revoke-api-key", f"id={record.id} prefix={record.prefix}")
    return {"ok": True, "id": key_id, "revoked": True}

