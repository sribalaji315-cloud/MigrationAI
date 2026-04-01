from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import func, text
from typing import Dict, List, Any, Optional
import io, csv, time, hashlib, threading
from ..db import models
from ..db.session import get_db, SessionLocal
from ..schemas import StateIn
from ..core.security import get_current_user

router = APIRouter(tags=["state"])

# ---------------------------------------------------------------------------
# In-memory dashboard metrics cache.  Keyed by a hash of the query params
# plus a fingerprint of the data (mapping count + feature count).  The cached
# result is returned until the user explicitly re-computes or the underlying
# data changes.
# ---------------------------------------------------------------------------
_metrics_cache: Dict[str, Any] = {}
_metrics_cache_fingerprint: Dict[str, str] = {}
_generation_lock = threading.Lock()

def _make_metrics_cache_key(category: Optional[str], product_type: Optional[str], include_excluded: bool) -> str:
    raw = f"{category or ''}|{product_type or ''}|{include_excluded}"
    return hashlib.md5(raw.encode()).hexdigest()

def _data_fingerprint(db: Session) -> str:
    """Cheap fingerprint: counts of mappings + features + items."""
    mc = db.query(func.count(models.GlobalMapping.id)).scalar() or 0
    fc = db.query(func.count(models.BomFeature.id)).scalar() or 0
    ic = db.query(func.count(models.BomItem.id)).scalar() or 0
    return f"{mc}:{fc}:{ic}"

def invalidate_metrics_cache():
    _metrics_cache.clear()
    _metrics_cache_fingerprint.clear()


def _resolve_value_mapping(value_mappings: Dict[str, str], legacy_value: str) -> Optional[str]:
    if not isinstance(value_mappings, dict):
        return None
    exact = value_mappings.get(legacy_value)
    if exact is not None and str(exact).strip() != "":
        return str(exact)
    space_idx = legacy_value.find(" ")
    if space_idx > 0:
        prefix = legacy_value[:space_idx]
        prefix_val = value_mappings.get(prefix)
        if prefix_val is not None and str(prefix_val).strip() != "":
            return str(prefix_val)
    return str(exact) if exact is not None else None


def _start_generation_job(job_id: int):
    worker = threading.Thread(
        target=_run_mapping_generation_job,
        args=(job_id,),
        daemon=True,
        name=f"mapping-generation-{job_id}",
    )
    worker.start()


def _run_mapping_generation_job(job_id: int):
    """Generate workspace mappings from BOM + global mappings in the background."""
    with _generation_lock:
        db = SessionLocal()
        try:
            job = db.query(models.MappingGenerationJob).filter(models.MappingGenerationJob.id == job_id).first()
            if not job:
                return

            now_ts = time.time()
            job.status = "running"
            if not job.started_at:
                job.started_at = now_ts
            job.updated_at = now_ts
            db.commit()

            # Full regeneration keeps the workspace mapping source aligned with
            # latest BOM uploads and global mapping rules.
            db.query(models.WorkspaceMapping).delete()
            db.commit()

            item_id_by_pk = {
                row_id: item_id
                for row_id, item_id in db.query(models.BomItem.id, models.BomItem.item_id).all()
            }

            mapping_by_feature: Dict[str, models.GlobalMapping] = {}
            for mapping in db.query(models.GlobalMapping).all():
                for feature_id in (getattr(mapping, "legacy_feature_ids", []) or []):
                    normalized = str(feature_id or "").strip()
                    if normalized and normalized not in mapping_by_feature:
                        mapping_by_feature[normalized] = mapping

            total_features = int(db.query(func.count(models.BomFeature.id)).scalar() or 0)
            processed_features = 0
            total_values = 0
            generated_rows = 0

            job.total_features = total_features
            job.processed_features = 0
            job.total_values = 0
            job.processed_values = 0
            job.generated_rows = 0
            job.updated_at = time.time()
            db.commit()

            rows_batch: List[Dict[str, Any]] = []

            def flush_rows():
                nonlocal rows_batch
                if rows_batch:
                    db.bulk_insert_mappings(models.WorkspaceMapping, rows_batch)
                    rows_batch = []

            for feat in db.query(models.BomFeature).yield_per(1500):
                legacy_item_id = item_id_by_pk.get(getattr(feat, "item_id", None))
                if not legacy_item_id:
                    processed_features += 1
                    continue

                mapping = mapping_by_feature.get(str(getattr(feat, "feature_id", "") or "").strip())
                target_attr = (getattr(mapping, "new_attribute_id", "") or "").strip() or "UNMAPPED"
                value_mappings = getattr(mapping, "value_mappings", {}) if mapping else {}

                raw_values = getattr(feat, "values", []) or []
                if isinstance(raw_values, dict):
                    values = [str(v) for v in (raw_values.get("values") or [])]
                elif isinstance(raw_values, list):
                    values = [str(v) for v in raw_values]
                else:
                    values = []

                signed_ts = job.started_at or time.time()
                if not values:
                    rows_batch.append(
                        {
                            "legacy_item_id": legacy_item_id,
                            "legacy_feature_id": getattr(feat, "feature_id", "") or "",
                            "legacy_value": "",
                            "new_attribute_id": target_attr,
                            "new_value": "",
                            "signed_on_by_user_id": job.triggered_by_user_id,
                            "signed_on_by_username": job.triggered_by_username,
                            "signed_on_at": signed_ts,
                            "updated_at": time.time(),
                        }
                    )
                    generated_rows += 1
                else:
                    for legacy_value in values:
                        resolved = _resolve_value_mapping(value_mappings, legacy_value)
                        rows_batch.append(
                            {
                                "legacy_item_id": legacy_item_id,
                                "legacy_feature_id": getattr(feat, "feature_id", "") or "",
                                "legacy_value": str(legacy_value),
                                "new_attribute_id": target_attr,
                                "new_value": (resolved or ""),
                                "signed_on_by_user_id": job.triggered_by_user_id,
                                "signed_on_by_username": job.triggered_by_username,
                                "signed_on_at": signed_ts,
                                "updated_at": time.time(),
                            }
                        )
                        generated_rows += 1
                    total_values += len(values)

                processed_features += 1

                if len(rows_batch) >= 6000:
                    flush_rows()

                if processed_features % 250 == 0:
                    flush_rows()
                    job.processed_features = processed_features
                    job.total_values = total_values
                    job.processed_values = total_values
                    job.generated_rows = generated_rows
                    job.updated_at = time.time()
                    db.commit()

            flush_rows()
            job.status = "completed"
            job.processed_features = processed_features
            job.total_values = total_values
            job.processed_values = total_values
            job.generated_rows = generated_rows
            job.finished_at = time.time()
            job.updated_at = job.finished_at
            db.commit()

        except Exception as exc:
            db.rollback()
            try:
                failed_job = db.query(models.MappingGenerationJob).filter(models.MappingGenerationJob.id == job_id).first()
                if failed_job:
                    failed_job.status = "failed"
                    failed_job.error_message = str(exc)
                    failed_job.finished_at = time.time()
                    failed_job.updated_at = failed_job.finished_at
                    db.commit()
            except Exception:
                db.rollback()
        finally:
            db.close()


def _prune_placeholder_global_mappings(mappings_payload: List[Dict]) -> List[Dict]:
    real_mapping_features = set()
    for mapping in mappings_payload or []:
        target_attr = str(mapping.get("newAttributeId") or "").strip()
        if not target_attr:
            continue
        for feature_id in mapping.get("legacyFeatureIds") or []:
            normalized = str(feature_id or "").strip()
            if normalized:
                real_mapping_features.add(normalized)

    pruned: List[Dict] = []
    for mapping in mappings_payload or []:
        target_attr = str(mapping.get("newAttributeId") or "").strip()
        feature_ids = [str(fid or "").strip() for fid in (mapping.get("legacyFeatureIds") or []) if str(fid or "").strip()]
        if not target_attr and len(feature_ids) == 1 and feature_ids[0] in real_mapping_features:
            continue
        pruned.append(mapping)
    return pruned

@router.get("/health")
def health():
    return {"ok": True}


@router.get("/mapping-generation/progress")
def get_mapping_generation_progress(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    # Any authenticated user can view live generation progress.
    try:
        active = (
            db.query(models.MappingGenerationJob)
            .filter(models.MappingGenerationJob.status.in_(["queued", "running"]))
            .order_by(models.MappingGenerationJob.updated_at.desc(), models.MappingGenerationJob.id.desc())
            .first()
        )
    except Exception:
        return {
            "status": "idle",
            "isActive": False,
            "progress": 0.0,
            "totalFeatures": 0,
            "processedFeatures": 0,
            "totalValues": 0,
            "processedValues": 0,
            "generatedRows": 0,
            "triggeredByUserId": None,
            "triggeredByUsername": None,
            "startedAt": None,
            "finishedAt": None,
            "updatedAt": None,
            "error": None,
        }

    job = active
    is_active = True
    if not job:
        is_active = False
        job = (
            db.query(models.MappingGenerationJob)
            .order_by(models.MappingGenerationJob.id.desc())
            .first()
        )

    if not job:
        return {
            "status": "idle",
            "isActive": False,
            "progress": 0.0,
            "totalFeatures": 0,
            "processedFeatures": 0,
            "totalValues": 0,
            "processedValues": 0,
            "generatedRows": 0,
            "triggeredByUserId": None,
            "triggeredByUsername": None,
            "startedAt": None,
            "finishedAt": None,
            "updatedAt": None,
            "error": None,
        }

    total_features = int(getattr(job, "total_features", 0) or 0)
    processed_features = int(getattr(job, "processed_features", 0) or 0)
    progress = (processed_features / total_features) if total_features > 0 else (1.0 if job.status == "completed" else 0.0)

    return {
        "id": job.id,
        "status": job.status,
        "isActive": bool(is_active),
        "progress": float(max(0.0, min(1.0, progress))),
        "totalFeatures": total_features,
        "processedFeatures": processed_features,
        "totalValues": int(getattr(job, "total_values", 0) or 0),
        "processedValues": int(getattr(job, "processed_values", 0) or 0),
        "generatedRows": int(getattr(job, "generated_rows", 0) or 0),
        "triggeredByUserId": getattr(job, "triggered_by_user_id", None),
        "triggeredByUsername": getattr(job, "triggered_by_username", None),
        "startedAt": getattr(job, "started_at", None),
        "finishedAt": getattr(job, "finished_at", None),
        "updatedAt": getattr(job, "updated_at", None),
        "error": getattr(job, "error_message", None),
    }


@router.get("/workspace-mappings/{item_id}")
def get_workspace_mappings_for_item(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    rows = (
        db.query(models.WorkspaceMapping)
        .filter(models.WorkspaceMapping.legacy_item_id == item_id)
        .order_by(models.WorkspaceMapping.legacy_feature_id, models.WorkspaceMapping.legacy_value)
        .all()
    )

    return [
        {
            "itemId": row.legacy_item_id,
            "legacyFeatureId": row.legacy_feature_id,
            "legacyValue": row.legacy_value,
            "newAttributeId": row.new_attribute_id,
            "newValue": row.new_value,
            "signedOnByUserId": row.signed_on_by_user_id,
            "signedOnByUsername": row.signed_on_by_username,
            "signedOnAt": row.signed_on_at,
            "updatedAt": row.updated_at,
        }
        for row in rows
    ]


@router.put("/workspace-mappings/{item_id}")
def put_workspace_mappings_for_item(
    item_id: str,
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    record = db.query(models.AppState).filter(models.AppState.id == 1).first()
    state_payload = dict(record.state) if record and record.state else {}
    locks = state_payload.get("locks") or {}
    lock = locks.get(item_id)

    current_user_id = f"USR-{current_user.id}"
    if getattr(current_user, "role", "user") != "admin":
        if not lock or lock.get("userId") != current_user_id:
            raise HTTPException(status_code=403, detail="item must be signed on by current user")

    rows_payload = payload.get("rows") or []
    if not isinstance(rows_payload, list):
        raise HTTPException(status_code=400, detail="rows must be an array")

    db.query(models.WorkspaceMapping).filter(models.WorkspaceMapping.legacy_item_id == item_id).delete()

    rows_to_add: List[Dict[str, Any]] = []
    signed_ts = time.time()
    for row in rows_payload:
        if not isinstance(row, dict):
            continue
        legacy_feature_id = str(row.get("legacyFeatureId") or row.get("legacy_feature_id") or "").strip()
        if not legacy_feature_id:
            continue

        rows_to_add.append(
            {
                "legacy_item_id": item_id,
                "legacy_feature_id": legacy_feature_id,
                "legacy_value": str(row.get("legacyValue") or row.get("legacy_value") or ""),
                "new_attribute_id": str(row.get("newAttributeId") or row.get("new_attribute_id") or "UNMAPPED"),
                "new_value": str(row.get("newValue") or row.get("new_value") or ""),
                "signed_on_by_user_id": current_user_id,
                "signed_on_by_username": getattr(current_user, "username", None),
                "signed_on_at": signed_ts,
                "updated_at": time.time(),
            }
        )

    if rows_to_add:
        db.bulk_insert_mappings(models.WorkspaceMapping, rows_to_add)

    db.commit()
    return {"ok": True, "rowsSaved": len(rows_to_add)}

@router.get("/state")
def get_state(include_bom: bool = Query(True), db: Session = Depends(get_db)):
    record = db.query(models.AppState).filter(models.AppState.id == 1).first()
    # build base state from JSON store (omitting whatever classification list may accidentally be there)
    if not record or not record.state:
        state = {"bom": [], "mappings": [], "classifications": [], "localMappings": {}, "itemClassifications": {}, "locks": {}, "users": []}
    else:
        # copy so we can override classifications
        state = dict(record.state)
        # ensure keys exist
        for key in ["bom", "mappings", "localMappings", "itemClassifications", "locks", "users"]:
            if key not in state:
                state[key] = [] if key in ["bom", "mappings", "users"] else {}
        # drop any classifications that might reside here; they are now kept in a dedicated table
        state["classifications"] = []

    # override/merge classification list from classification table
    db_classes = db.query(models.Classification).all()
    state["classifications"] = [
        {"classId": c.class_id, "className": c.class_name, "attributes": c.attributes or []}
        for c in db_classes
    ]

    # also surface auth users from the users table in the shared state so the
    # User Identity Registry can see all accounts, not just those stored in
    # the AppState JSON. Existing JSON users are kept, and DB users are
    # merged in if they are missing.
    json_users: List[Dict] = state.get("users") or []
    # index existing JSON users by username for quick lookup
    existing_by_name = {u.get("userName"): u for u in json_users if isinstance(u, dict)}

    db_users = db.query(models.User).all()
    for u in db_users:
        if u.username not in existing_by_name:
            json_users.append({
                "userId": f"USR-{u.id}",
                "userName": u.username,
                # we never expose the real password hash to the UI; this
                # placeholder simply keeps the shape compatible
                "password": "",
                "role": u.role or "user",
            })

    state["users"] = json_users

    # --- Override BOM from dedicated tables --------------------------------------
    if include_bom:
        db_items = db.query(models.BomItem).options(selectinload(models.BomItem.features)).all()
        bom_payload: List[Dict[str, Any]] = []
        for itm in db_items:
            features_payload: List[Dict[str, Any]] = []
            for feat in itm.features:
                raw_values: Any = getattr(feat, "values", []) or []

                # Support both the original representation (list of strings)
                # and a richer object with value descriptions stored in the JSON
                values: List[str]
                value_descriptions: Dict[str, str]

                if isinstance(raw_values, list):
                    values = [str(v) for v in raw_values]
                    value_descriptions = {}
                elif isinstance(raw_values, dict):
                    values_raw = raw_values.get("values") or []
                    values = [str(v) for v in values_raw]
                    vd = raw_values.get("valueDescriptions") or {}
                    # normalise keys to strings
                    value_descriptions = {
                        str(k): str(v)
                        for k, v in vd.items()
                        if k is not None
                    }
                else:
                    values = []
                    value_descriptions = {}

                features_payload.append(
                    {
                        "featureId": getattr(feat, "feature_id", None),
                        "description": getattr(feat, "description", ""),
                        **({"unit": getattr(feat, "unit", None)} if getattr(feat, "unit", None) else {}),
                        "values": values,
                        **({"valueDescriptions": value_descriptions} if value_descriptions else {}),
                    }
                )
            bom_payload.append(
                {
                    "itemId": getattr(itm, "item_id", None),
                    "description": getattr(itm, "description", ""),
                    **({"category": getattr(itm, "category", None)} if getattr(itm, "category", None) else {}),
                    **({"productType": getattr(itm, "product_type", None)} if getattr(itm, "product_type", None) else {}),
                    "features": features_payload,
                }
            )
        state["bom"] = bom_payload
    else:
        state["bom"] = []

    # --- Override global mappings from dedicated table ---------------------------
    db_mappings = db.query(models.GlobalMapping).all()
    mappings_payload: List[Dict] = []
    for m in db_mappings:
        mappings_payload.append(
            {
                "legacyFeatureIds": getattr(m, "legacy_feature_ids", []) or [],
                "newAttributeId": getattr(m, "new_attribute_id", ""),
                "attributeType": getattr(m, "attribute_type", "") or "",
                "valueMappings": getattr(m, "value_mappings", {}) or {},
            }
        )
    state["mappings"] = mappings_payload

    # --- Override local item-level mappings from workspace mapping rows ----------
    local_by_item: Dict[str, Dict[tuple, Dict]] = {}

    try:
        workspace_rows = db.query(models.WorkspaceMapping).all()
        for row in workspace_rows:
            item_id = getattr(row, "legacy_item_id", None)
            legacy_attr = getattr(row, "legacy_feature_id", None)
            new_attr = getattr(row, "new_attribute_id", None)
            legacy_val = getattr(row, "legacy_value", None)
            new_val = getattr(row, "new_value", None)
            if not item_id or not legacy_attr or not new_attr or legacy_val is None:
                continue

            bucket = local_by_item.setdefault(item_id, {})
            key = (legacy_attr, new_attr)
            mapping_obj = bucket.get(key)
            if not mapping_obj:
                mapping_obj = {
                    "legacyFeatureIds": [legacy_attr],
                    "newAttributeId": new_attr,
                    "attributeType": "",
                    "valueMappings": {},
                }
                bucket[key] = mapping_obj

            # Sentinel rows (empty legacy/new value pair) represent
            # attribute-level overrides and should keep valueMappings empty.
            if str(legacy_val) == "" and str(new_val or "") == "":
                continue

            mapping_obj["valueMappings"][str(legacy_val)] = str(new_val or "")

    except Exception:
        # Fallback during migration rollout when workspace_mappings table
        # may not exist yet.
        db_locals = db.query(models.LocalAttributeMapping).all()
        for row in db_locals:
            item_id = getattr(row, "item_id", None)
            legacy_attr = getattr(row, "legacy_attribute_id", None)
            new_attr = getattr(row, "new_attribute_id", None)
            legacy_val = getattr(row, "legacy_value", None)
            new_val = getattr(row, "new_value", None)
            if not item_id or not legacy_attr or not new_attr or legacy_val is None:
                continue

            bucket = local_by_item.setdefault(item_id, {})
            key = (legacy_attr, new_attr)
            mapping_obj = bucket.get(key)
            if not mapping_obj:
                mapping_obj = {
                    "legacyFeatureIds": [legacy_attr],
                    "newAttributeId": new_attr,
                    "attributeType": "",
                    "valueMappings": {},
                }
                bucket[key] = mapping_obj

            if str(legacy_val) == "" and str(new_val or "") == "":
                continue

            mapping_obj["valueMappings"][str(legacy_val)] = str(new_val or "")

    local_payload: Dict[str, List[Dict]] = {
        item_id: list(grouped.values())
        for item_id, grouped in local_by_item.items()
    }

    state["localMappings"] = local_payload

    return state


@router.get("/bom/filters")
def get_bom_filters(
    category: Optional[str] = None,
    productType: Optional[str] = None,
    productLine: Optional[str] = Query(None, alias="productLine"),
    db: Session = Depends(get_db),
):
    selected_product_type = productType or productLine
    base_query = db.query(models.BomItem)
    if category:
        base_query = base_query.filter(models.BomItem.category == category)
    if selected_product_type:
        base_query = base_query.filter(models.BomItem.product_type == selected_product_type)

    categories = (
        base_query.with_entities(models.BomItem.category)
        .distinct()
        .all()
    )
    product_types = (
        base_query.with_entities(models.BomItem.product_type)
        .distinct()
        .all()
    )

    category_list = sorted({c[0] for c in categories if c and c[0]})
    product_type_list = sorted({p[0] for p in product_types if p and p[0]})

    return {"categories": category_list, "productTypes": product_type_list}


@router.get("/bom/count")
def get_bom_count(
    category: Optional[str] = None,
    productType: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Return only the total count of BOM items matching the filter — no feature data."""
    query = db.query(func.count(models.BomItem.id))
    if category:
        query = query.filter(models.BomItem.category == category)
    if productType:
        query = query.filter(models.BomItem.product_type == productType)
    total = query.scalar() or 0
    return {"total": total}


def _build_bom_payload(db_items: List[models.BomItem]) -> List[Dict[str, Any]]:
    bom_payload: List[Dict[str, Any]] = []

    for itm in db_items:
        features_payload: List[Dict[str, Any]] = []
        for feat in itm.features:
            raw_values: Any = getattr(feat, "values", []) or []
            values: List[str]
            value_descriptions: Dict[str, str]

            if isinstance(raw_values, list):
                values = [str(v) for v in raw_values]
                value_descriptions = {}
            elif isinstance(raw_values, dict):
                values_raw = raw_values.get("values") or []
                values = [str(v) for v in values_raw]
                vd = raw_values.get("valueDescriptions") or {}
                value_descriptions = {
                    str(k): str(v)
                    for k, v in vd.items()
                    if k is not None
                }
            else:
                values = []
                value_descriptions = {}

            features_payload.append(
                {
                    "featureId": getattr(feat, "feature_id", None),
                    "description": getattr(feat, "description", ""),
                    **({"unit": getattr(feat, "unit", None)} if getattr(feat, "unit", None) else {}),
                    "values": values,
                    **({"valueDescriptions": value_descriptions} if value_descriptions else {}),
                }
            )

        bom_payload.append(
            {
                "itemId": getattr(itm, "item_id", None),
                "description": getattr(itm, "description", ""),
                **({"category": getattr(itm, "category", None)} if getattr(itm, "category", None) else {}),
                **({"productType": getattr(itm, "product_type", None)} if getattr(itm, "product_type", None) else {}),
                "features": features_payload,
            }
        )

    return bom_payload


@router.get("/bom/items")
def get_bom_items(
    category: Optional[str] = None,
    productType: Optional[str] = None,
    limit: int = Query(0, ge=0, le=5000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    query = db.query(models.BomItem).options(selectinload(models.BomItem.features))
    if category:
        query = query.filter(models.BomItem.category == category)
    if productType:
        query = query.filter(models.BomItem.product_type == productType)

    query = query.order_by(models.BomItem.item_id)
    if limit:
        query = query.limit(limit).offset(offset)

    db_items = query.all()
    return _build_bom_payload(db_items)


@router.post("/bom/items/by-ids")
def get_bom_items_by_ids(
    payload: List[str],
    db: Session = Depends(get_db),
):
    item_ids = [i for i in payload if i]
    if not item_ids:
        return []

    db_items = db.query(models.BomItem).options(selectinload(models.BomItem.features)).filter(models.BomItem.item_id.in_(item_ids)).all()
    return _build_bom_payload(db_items)

@router.post("/sync")
def sync_state(payload: StateIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # when classifications are persisted separately we ignore that property on sync requests
    incoming = dict(payload.state)
    incoming.pop("classifications", None)

    # peel off BOM, mappings and localMappings so they are stored in dedicated tables
    # Only replace BOM when it is explicitly included in the payload (key present and non-null).
    # Workspace saves don't include the full BOM, so we must not wipe the table for those.
    bom_key_present = "bom" in incoming
    bom_payload = incoming.pop("bom", None)
    mappings_payload = _prune_placeholder_global_mappings(incoming.pop("mappings", []) or [])
    local_mappings_payload = incoming.pop("localMappings", {}) or {}
    should_trigger_generation = bool(bom_key_present and bom_payload is not None)
    mapping_generation_job_id: Optional[int] = None

    # Replace BOM & features ONLY when the caller explicitly sent a bom list
    if bom_key_present and bom_payload is not None:
        db.query(models.BomFeature).delete()
        db.query(models.BomItem).delete()

        bom_item_rows: List[Dict[str, Any]] = []
        feature_payload_by_item_id: Dict[str, List[Dict[str, Any]]] = {}

        for item in (bom_payload or []):
            item_id = item.get("itemId")
            if not item_id:
                continue

            bom_item_rows.append(
                {
                    "item_id": item_id,
                    "description": item.get("description") or "",
                    "category": item.get("category") or None,
                    "product_type": item.get("productType") or None,
                }
            )
            feature_payload_by_item_id[item_id] = item.get("features") or []

        if bom_item_rows:
            db.bulk_insert_mappings(models.BomItem, bom_item_rows)
            db.flush()

            inserted_items = (
                db.query(models.BomItem.id, models.BomItem.item_id)
                .filter(models.BomItem.item_id.in_([row["item_id"] for row in bom_item_rows]))
                .all()
            )
            item_pk_by_item_id = {item_id: pk for pk, item_id in inserted_items}

            bom_feature_rows: List[Dict[str, Any]] = []
            for item_id, feature_payload in feature_payload_by_item_id.items():
                item_pk = item_pk_by_item_id.get(item_id)
                if not item_pk:
                    continue
                for feat in feature_payload:
                    feature_id = feat.get("featureId")
                    if not feature_id:
                        continue

                    raw_values = feat.get("values") or []
                    value_descriptions = feat.get("valueDescriptions") or {}

                    if value_descriptions:
                        composite_values: Any = {
                            "values": raw_values,
                            "valueDescriptions": value_descriptions,
                        }
                    else:
                        composite_values = raw_values

                    bom_feature_rows.append(
                        {
                            "item_id": item_pk,
                            "feature_id": feature_id,
                            "description": feat.get("description") or "",
                            "unit": feat.get("unit") or None,
                            "values_json": composite_values,
                        }
                    )

            if bom_feature_rows:
                db.bulk_insert_mappings(models.BomFeature, bom_feature_rows)

    # Replace global mappings
    db.query(models.GlobalMapping).delete()
    global_mappings_to_add: List[Dict[str, Any]] = []
    for m in mappings_payload:
        raw_attr_type = m.get("attributeType")
        attr_type = str(raw_attr_type).strip().lower() if raw_attr_type is not None else ""
        global_mappings_to_add.append(
            {
                "legacy_feature_ids": m.get("legacyFeatureIds") or [],
                "new_attribute_id": m.get("newAttributeId") or "",
                "attribute_type": attr_type,
                "value_mappings": m.get("valueMappings") or {},
            }
        )
    if global_mappings_to_add:
        db.bulk_insert_mappings(models.GlobalMapping, global_mappings_to_add)

    # Replace local attribute mappings
    db.query(models.LocalAttributeMapping).delete()

    item_ids = list((local_mappings_payload or {}).keys())
    bom_rows = db.query(models.BomItem).filter(models.BomItem.item_id.in_(item_ids)).all()
    bom_by_item_id = {row.item_id: row for row in bom_rows}

    local_mappings_to_add: List[Dict[str, Any]] = []
    for item_id, mappings_for_item in (local_mappings_payload or {}).items():
        if not item_id:
            continue

        # Look up description from BOM table if present
        bom_row = bom_by_item_id.get(item_id)
        item_desc = getattr(bom_row, "description", "") if bom_row else ""
        item_category = getattr(bom_row, "category", None) if bom_row else None
        item_product_type = getattr(bom_row, "product_type", None) if bom_row else None

        for m in mappings_for_item or []:
            legacy_ids = m.get("legacyFeatureIds") or []
            new_attr = m.get("newAttributeId") or ""
            values_map = m.get("valueMappings") or {}

            for legacy_attr in legacy_ids:
                # If there are no per-value mappings, we still need to persist the
                # attribute-level override (e.g. NOT REQUIRED) so that it survives
                # a round-trip through the database. We do this by inserting a
                # sentinel row with an empty legacy_value / new_value pair.
                if not values_map:
                    local_mappings_to_add.append(
                        {
                            "item_id": item_id,
                            "item_description": item_desc,
                            "category": item_category,
                            "product_type": item_product_type,
                            "legacy_attribute_id": legacy_attr,
                            "legacy_value": "",
                            "new_attribute_id": new_attr,
                            "new_value": "",
                        }
                    )
                    continue

                for legacy_val, new_val in values_map.items():
                    if legacy_attr and legacy_val is not None:
                        local_mappings_to_add.append(
                            {
                                "item_id": item_id,
                                "item_description": item_desc,
                                "category": item_category,
                                "product_type": item_product_type,
                                "legacy_attribute_id": legacy_attr,
                                "legacy_value": str(legacy_val),
                                "new_attribute_id": new_attr,
                                "new_value": str(new_val),
                            }
                        )
    
    if local_mappings_to_add:
        db.bulk_insert_mappings(models.LocalAttributeMapping, local_mappings_to_add)

    # New workspace source-of-truth table for mapping workspace reads.
    # Keep this in sync with incoming local mappings while rollout is in progress.
    try:
        db.query(models.WorkspaceMapping).delete()

        current_user_id = f"USR-{current_user.id}"
        signed_ts = time.time()
        workspace_rows_to_add: List[Dict[str, Any]] = []
        for row in local_mappings_to_add:
            workspace_rows_to_add.append(
                {
                    "legacy_item_id": row.get("item_id") or "",
                    "legacy_feature_id": row.get("legacy_attribute_id") or "",
                    "legacy_value": str(row.get("legacy_value") or ""),
                    "new_attribute_id": row.get("new_attribute_id") or "UNMAPPED",
                    "new_value": str(row.get("new_value") or ""),
                    "signed_on_by_user_id": current_user_id,
                    "signed_on_by_username": getattr(current_user, "username", None),
                    "signed_on_at": signed_ts,
                    "updated_at": time.time(),
                }
            )

        if workspace_rows_to_add:
            db.bulk_insert_mappings(models.WorkspaceMapping, workspace_rows_to_add)
    except Exception:
        # Table may not exist before migration is applied.
        pass

    # Persist the remainder of the JSON state as a lightweight shell
    record = db.query(models.AppState).filter(models.AppState.id == 1).first()
    if not record:
        record = models.AppState(id=1, state=incoming)
        db.add(record)
    else:
        record.state = incoming

    db.commit()

    if should_trigger_generation:
        post_db = SessionLocal()
        try:
            queued_job = models.MappingGenerationJob(
                status="queued",
                triggered_by_user_id=f"USR-{current_user.id}",
                triggered_by_username=getattr(current_user, "username", None),
                trigger_source="bom_upload",
                total_features=0,
                processed_features=0,
                total_values=0,
                processed_values=0,
                generated_rows=0,
                started_at=None,
                finished_at=None,
                updated_at=time.time(),
                error_message=None,
            )
            post_db.add(queued_job)
            post_db.commit()
            post_db.refresh(queued_job)
            mapping_generation_job_id = int(queued_job.id)
            _start_generation_job(mapping_generation_job_id)
        except Exception:
            post_db.rollback()
            mapping_generation_job_id = None
        finally:
            post_db.close()

    invalidate_metrics_cache()
    return {"ok": True, "mappingGenerationJobId": mapping_generation_job_id}

@router.post("/lock")
def handle_lock(action_payload: Dict, db: Session = Depends(get_db)):
    """Acquire or release an item-level edit lock.

    The state JSON column is treated immutably here (copied and reassigned)
    so that SQLAlchemy reliably detects changes to the JSON structure.
    
    Note: Auth is not required for this endpoint to allow users to release their own locks
    even if there are auth issues. The userId in the payload is still validated.
    """
    print(f"[LOCK] Received action_payload: {action_payload}")
    # Expected payload: { itemId, userId?, userName?, action }
    action = action_payload.get("action")
    itemId = action_payload.get("itemId")
    if not itemId or not action:
        raise HTTPException(status_code=400, detail="itemId and action required")

    record = db.query(models.AppState).filter(models.AppState.id == 1).first()

    # Start from existing state if present, otherwise an empty shell
    base_state: Dict = dict(record.state) if record and record.state else {}

    # Ensure a locks map exists and work on a shallow copy so that
    # we always assign a new object back into state.
    existing_locks = base_state.get("locks") or {}
    locks: Dict = dict(existing_locks)

    response_payload: Dict[str, Any] = {"ok": True}

    if action == "acquire":
        userId = action_payload.get("userId")
        userName = action_payload.get("userName")
        existing = locks.get(itemId)
        if existing and existing.get("userId") != userId:
            # Another user holds this lock
            return {"acquired": False, "reason": "locked"}
        if not existing:
            user_lock_count = sum(1 for l in locks.values() if l.get("userId") == userId)
            if user_lock_count >= 2:
                return {"acquired": False, "reason": "limit"}
        locks[itemId] = {
            "itemId": itemId,
            "userId": userId,
            "userName": userName,
            "timestamp": __import__("time").time() * 1000,
        }
        response_payload = {"acquired": True}
    elif action == "release":
        userId = action_payload.get("userId")
        print(f"[LOCK RELEASE] Attempting to release itemId={itemId}, userId={userId}, current locks: {locks}")
        if locks.get(itemId) and locks[itemId].get("userId") == userId:
            locks.pop(itemId, None)
            print(f"[LOCK RELEASE] Successfully released lock, remaining locks: {locks}")
        else:
            print(f"[LOCK RELEASE] Failed to release - condition not met. Lock exists: {locks.get(itemId) is not None}, UserId match: {locks.get(itemId) and locks[itemId].get('userId') == userId if locks.get(itemId) else False}")
    elif action == "force-release":
        # Force release without auth check for now (for debugging)
        # In production, this should check admin role
        locks.pop(itemId, None)
        print(f"[LOCK FORCE-RELEASE] Force released itemId={itemId}, remaining locks: {locks}")
    else:
        raise HTTPException(status_code=400, detail="unknown action")

    # Rebuild state with the updated locks map to guarantee SQLAlchemy
    # sees a new JSON structure.
    base_state["locks"] = locks

    if not record:
        record = models.AppState(id=1, state=base_state)
        db.add(record)
    else:
        record.state = base_state

    db.commit()
    return response_payload


@router.get("/dashboard/metrics")
def get_dashboard_metrics(
    category: Optional[str] = None,
    productType: Optional[str] = None,
    productLine: Optional[str] = Query(None, alias="productLine"),
    includeExcluded: bool = Query(False, alias="includeExcluded"),
    forceRecompute: bool = Query(False, alias="forceRecompute"),
    db: Session = Depends(get_db),
):
    selected_product_type = productType or productLine

    # --- check cache ---
    cache_key = _make_metrics_cache_key(category, selected_product_type, includeExcluded)
    fingerprint = _data_fingerprint(db)

    if not forceRecompute and cache_key in _metrics_cache and _metrics_cache_fingerprint.get(cache_key) == fingerprint:
        return _metrics_cache[cache_key]

    # --- Build per-feature mapping lookup using a single DB pass ---
    mapping_rows = db.query(models.GlobalMapping).all()
    mapping_by_feature: Dict[str, models.GlobalMapping] = {}
    for mapping in mapping_rows:
        for feature_id in (getattr(mapping, "legacy_feature_ids", []) or []):
            if feature_id and feature_id not in mapping_by_feature:
                mapping_by_feature[feature_id] = mapping

    state_record = db.query(models.AppState).filter(models.AppState.id == 1).first()
    state_payload = dict(state_record.state) if state_record and state_record.state else {}
    mapping_type_config = state_payload.get("mappingTypeConfig") or {}
    available_types = [str(v).strip().lower() for v in (mapping_type_config.get("availableTypes") or []) if str(v).strip()]
    included_types = [str(v).strip().lower() for v in (mapping_type_config.get("includedTypes") or []) if str(v).strip()]
    included_type_set = set(included_types if included_types else available_types) if available_types else None

    def _resolve_value_mapping(value_mappings: Dict[str, str], legacy_value: str) -> Optional[str]:
        if not isinstance(value_mappings, dict):
            return None
        exact = value_mappings.get(legacy_value)
        if exact is not None and str(exact).strip() != "":
            return str(exact)
        space_idx = legacy_value.find(" ")
        if space_idx > 0:
            prefix = legacy_value[:space_idx]
            prefix_val = value_mappings.get(prefix)
            if prefix_val is not None and str(prefix_val).strip() != "":
                return str(prefix_val)
        return str(exact) if exact is not None else None

    # --- Fetch only the lightweight item rows (no features yet) ---
    items_query = db.query(models.BomItem)
    if category:
        items_query = items_query.filter(models.BomItem.category == category)
    if selected_product_type:
        items_query = items_query.filter(models.BomItem.product_type == selected_product_type)
    bom_items = items_query.order_by(models.BomItem.item_id).all()

    item_pk_to_obj: Dict[int, models.BomItem] = {itm.id: itm for itm in bom_items}
    item_pks = list(item_pk_to_obj.keys())

    # --- Stream features in batches to avoid loading 2M rows at once ---
    BATCH = 5000
    # Accumulate per-item stats keyed by item PK
    per_item: Dict[int, Dict[str, int]] = {pk: {
        "total": 0, "mapped": 0, "not_required": 0, "excluded": 0,
        "total_vals": 0, "mapped_vals": 0, "excluded_vals": 0,
    } for pk in item_pks}

    total_features = 0
    mapped_features = 0
    total_values = 0
    mapped_values = 0
    not_required_features = 0
    excluded_features = 0
    excluded_values = 0

    for i in range(0, len(item_pks), BATCH):
        batch_pks = item_pks[i:i + BATCH]
        features = (
            db.query(models.BomFeature)
            .filter(models.BomFeature.item_id.in_(batch_pks))
            .yield_per(2000)
            .all()
        )
        for feat in features:
            stats = per_item.get(feat.item_id)
            if not stats:
                continue

            stats["total"] += 1
            total_features += 1

            mapping = mapping_by_feature.get(feat.feature_id)
            attr_type = (getattr(mapping, "attribute_type", "") or "").strip().lower()
            is_excluded = bool(included_type_set and attr_type and attr_type not in included_type_set)
            target_attr = (getattr(mapping, "new_attribute_id", "") or "").strip().upper()

            raw_values = getattr(feat, "values", []) or []
            if isinstance(raw_values, dict):
                values = [str(v) for v in (raw_values.get("values") or [])]
            elif isinstance(raw_values, list):
                values = [str(v) for v in raw_values]
            else:
                values = []

            num_values = len(values)

            if is_excluded:
                stats["excluded"] += 1
                excluded_features += 1
                stats["excluded_vals"] += num_values
                excluded_values += num_values
                if not includeExcluded:
                    stats["total"] -= 1
                    total_features -= 1
                    continue

            if target_attr == "NOT REQUIRED":
                stats["not_required"] += 1
                not_required_features += 1
            elif target_attr and target_attr != "UNMAPPED":
                stats["mapped"] += 1
                mapped_features += 1

            value_mappings = getattr(mapping, "value_mappings", {}) if mapping else {}
            for legacy_value in values:
                stats["total_vals"] += 1
                total_values += 1
                resolved = _resolve_value_mapping(value_mappings, legacy_value)
                if resolved is not None and resolved.strip() != "":
                    stats["mapped_vals"] += 1
                    mapped_values += 1

    items_fully_mapped = 0
    item_rows: List[Dict[str, Any]] = []

    for pk in item_pks:
        itm = item_pk_to_obj[pk]
        s = per_item[pk]
        mappable = max(0, s["total"] - s["not_required"])
        attr_complete = mappable == 0 or s["mapped"] >= mappable
        vals_complete = s["total_vals"] == 0 or s["mapped_vals"] >= s["total_vals"]
        fully = attr_complete and vals_complete
        if fully:
            items_fully_mapped += 1
        item_rows.append({
            "itemId": itm.item_id,
            "description": itm.description or "",
            "category": itm.category or "",
            "productType": itm.product_type or "",
            "totalFeatures": s["total"],
            "mappedFeatures": s["mapped"],
            "notRequiredFeatures": s["not_required"],
            "excludedFeatures": s["excluded"],
            "totalValues": s["total_vals"],
            "mappedValues": s["mapped_vals"],
            "excludedValues": s["excluded_vals"],
            "fullyMapped": fully,
        })

    feature_denominator = max(0, total_features - not_required_features)
    attribute_coverage = (mapped_features / feature_denominator) if feature_denominator else 0
    value_coverage = (mapped_values / total_values) if total_values else 0
    item_coverage = (items_fully_mapped / len(bom_items)) if bom_items else 0

    result = {
        "totals": {
            "items": int(len(bom_items)),
            "features": int(total_features),
            "values": int(total_values),
        },
        "mapped": {
            "features": int(mapped_features),
            "values": int(mapped_values),
            "items": int(items_fully_mapped),
            "notRequiredFeatures": int(not_required_features),
        },
        "excluded": {
            "features": int(excluded_features),
            "values": int(excluded_values),
        },
        "coverage": {
            "attribute": float(attribute_coverage),
            "value": float(value_coverage),
            "item": float(item_coverage),
        },
        "includeExcluded": bool(includeExcluded),
        "items": item_rows,
    }

    # Store in cache
    _metrics_cache[cache_key] = result
    _metrics_cache_fingerprint[cache_key] = fingerprint

    return result


@router.get("/item-statuses")
def get_item_statuses(db: Session = Depends(get_db)):
        # Status is computed server-side to avoid O(n*m) work in the browser.
        rows = db.execute(
                text(
                        """
                        WITH feature_mapping AS (
                            SELECT
                                bi.item_id AS item_id,
                                bf.id AS feature_row_id,
                                bf.feature_id AS feature_id,
                                MAX(
                                    CASE
                                        WHEN UPPER(COALESCE(gm.new_attribute_id, '')) NOT IN ('', 'UNMAPPED', 'NOT REQUIRED') THEN 1
                                        ELSE 0
                                    END
                                ) AS has_mapped_attr,
                                MAX(
                                    CASE
                                        WHEN UPPER(COALESCE(gm.new_attribute_id, '')) = 'NOT REQUIRED' THEN 1
                                        ELSE 0
                                    END
                                ) AS is_not_required
                            FROM bom_items bi
                            JOIN bom_features bf ON bf.item_id = bi.id
                            LEFT JOIN global_mappings gm
                                ON EXISTS (
                                    SELECT 1 FROM json_each(gm.legacy_feature_ids)
                                    WHERE json_each.value = bf.feature_id
                                )
                            GROUP BY bi.item_id, bf.id, bf.feature_id
                        )
                        SELECT
                            item_id,
                            SUM(CASE WHEN has_mapped_attr = 1 THEN 1 ELSE 0 END) AS mapped_count,
                            SUM(CASE WHEN is_not_required = 1 THEN 1 ELSE 0 END) AS not_required_count,
                            COUNT(*) AS total_count
                        FROM feature_mapping
                        GROUP BY item_id
                        """
                )
        ).mappings().all()

        statuses: Dict[str, str] = {}
        for row in rows:
                item_id = row["item_id"]
                mapped_count = int(row["mapped_count"] or 0)
                not_required_count = int(row["not_required_count"] or 0)
                total_count = int(row["total_count"] or 0)

                if total_count == 0:
                        statuses[item_id] = "notRequired"
                elif mapped_count + not_required_count >= total_count and mapped_count > 0:
                        statuses[item_id] = "mapped"
                elif mapped_count == 0 and not_required_count >= total_count:
                        statuses[item_id] = "notRequired"
                else:
                        statuses[item_id] = "unmapped"

        return {"statuses": statuses}


@router.get("/export/bom-csv")
def export_bom_csv(db: Session = Depends(get_db)):
        def iter_rows():
                output = io.StringIO()
                writer = csv.writer(output)
                writer.writerow([
                        "Item ID",
                        "Description",
                        "Legacy Attribute",
                        "Legacy Value",
                        "Target Attribute",
                        "Target Value",
                        "Attribute Type",
                ])
                yield output.getvalue()
                output.seek(0)
                output.truncate(0)

                items = db.query(models.BomItem).options(selectinload(models.BomItem.features)).all()

                mapping_rows = db.query(models.GlobalMapping).all()
                by_feature: Dict[str, models.GlobalMapping] = {}
                for m in mapping_rows:
                        for fid in getattr(m, "legacy_feature_ids", []) or []:
                                if fid and fid not in by_feature:
                                        by_feature[fid] = m

                for item in items:
                        for feature in item.features:
                                mapping = by_feature.get(feature.feature_id)
                                target_attr = getattr(mapping, "new_attribute_id", "") if mapping else ""
                                attr_type = getattr(mapping, "attribute_type", "") if mapping else ""
                                value_mappings = getattr(mapping, "value_mappings", {}) if mapping else {}

                                raw_values = getattr(feature, "values", []) or []
                                if isinstance(raw_values, dict):
                                        values = [str(v) for v in (raw_values.get("values") or [])]
                                elif isinstance(raw_values, list):
                                        values = [str(v) for v in raw_values]
                                else:
                                        values = []

                                if not values:
                                        writer.writerow([
                                                item.item_id,
                                                item.description or "",
                                                feature.feature_id,
                                                "",
                                                target_attr,
                                                "",
                                                attr_type,
                                        ])
                                        yield output.getvalue()
                                        output.seek(0)
                                        output.truncate(0)
                                        continue

                                for v in values:
                                        target_val = ""
                                        if isinstance(value_mappings, dict):
                                                target_val = value_mappings.get(v, "")
                                        writer.writerow([
                                                item.item_id,
                                                item.description or "",
                                                feature.feature_id,
                                                v,
                                                target_attr,
                                                target_val,
                                                attr_type,
                                        ])
                                        yield output.getvalue()
                                        output.seek(0)
                                        output.truncate(0)

        filename = "bom_export.csv"
        headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
        return StreamingResponse(iter_rows(), media_type="text/csv", headers=headers)

@router.post("/reset")
def reset(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # only admins may reset the application state
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="admin role required to reset state")
    record = db.query(models.AppState).filter(models.AppState.id == 1).first()
    if record:
        db.delete(record)

    # also nuke any classifications, BOM, mappings and local overrides so
    # reset truly returns to defaults
    db.query(models.Classification).delete()
    db.query(models.BomFeature).delete()
    db.query(models.BomItem).delete()
    db.query(models.GlobalMapping).delete()
    db.query(models.LocalAttributeMapping).delete()
    try:
        db.query(models.WorkspaceMapping).delete()
        db.query(models.MappingGenerationJob).delete()
    except Exception:
        # Migration may not be applied yet.
        pass
    db.commit()
    invalidate_metrics_cache()
    return {"ok": True}
