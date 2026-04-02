from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import func, or_, cast, String
from sqlalchemy.exc import IntegrityError, OperationalError
from typing import Dict, List, Any, Optional
import io, csv, time, hashlib, asyncio, logging
from ..db import models
from ..db.session import get_db, SessionLocal
from ..schemas import StateIn
from ..core.security import get_current_user
from .websocket import broadcast_lock_change, broadcast_mapping_update, broadcast_generation_progress, broadcast_sync

logger = logging.getLogger("erp_migrator")
router = APIRouter(tags=["state"])

MAX_SEARCH_LENGTH = 100
MAX_EXPORT_ROWS = 100_000

# ---------------------------------------------------------------------------
# In-memory dashboard metrics cache.  Keyed by a hash of the query params
# plus a fingerprint of the data (mapping count + feature count).  The cached
# result is returned until the user explicitly re-computes or the underlying
# data changes.
# ---------------------------------------------------------------------------
_metrics_cache: Dict[str, Any] = {}
_metrics_cache_fingerprint: Dict[str, str] = {}
_generation_lock = asyncio.Lock()
GENERATION_STALE_TIMEOUT_SECONDS = 15 * 60
GENERATION_INSERT_BATCH_SIZE = 1500
GENERATION_INSERT_MAX_RETRIES = 5

def _make_metrics_cache_key(category: Optional[str], product_type: Optional[str], include_excluded: bool) -> str:
    raw = f"{category or ''}|{product_type or ''}|{include_excluded}"
    return hashlib.md5(raw.encode()).hexdigest()

def _data_fingerprint(db: Session) -> str:
    """Cheap fingerprint: counts of mappings + features + items + workspace mappings."""
    mc = db.query(func.count(models.GlobalMapping.id)).scalar() or 0
    fc = db.query(func.count(models.BomFeature.id)).scalar() or 0
    ic = db.query(func.count(models.BomItem.id)).scalar() or 0
    wc = db.query(func.count(models.WorkspaceMapping.id)).scalar() or 0
    return f"{mc}:{fc}:{ic}:{wc}"

def invalidate_metrics_cache():
    _metrics_cache.clear()
    _metrics_cache_fingerprint.clear()


def _cleanup_stale_generation_jobs(db: Session, stale_after_seconds: float = GENERATION_STALE_TIMEOUT_SECONDS) -> int:
    """Mark orphaned queued/running generation jobs as failed after heartbeat timeout."""
    now_ts = time.time()
    stale_cutoff = now_ts - stale_after_seconds
    stale_jobs = (
        db.query(models.MappingGenerationJob)
        .filter(models.MappingGenerationJob.status.in_(["queued", "running"]))
        .filter(models.MappingGenerationJob.updated_at < stale_cutoff)
        .all()
    )
    if not stale_jobs:
        return 0

    for stale_job in stale_jobs:
        stale_job.status = "failed"
        stale_job.error_message = "Generation worker heartbeat timed out"
        stale_job.finished_at = now_ts
        stale_job.updated_at = now_ts

    db.commit()
    return len(stale_jobs)


def _validate_search(search: Optional[str]) -> Optional[str]:
    """Cap search input length to prevent DoS via huge LIKE patterns."""
    if search and len(search) > MAX_SEARCH_LENGTH:
        raise HTTPException(status_code=400, detail=f"Search query too long (max {MAX_SEARCH_LENGTH} chars)")
    return search


def _audit(db: Session, user: Optional[models.User], action: str, detail: str = ""):
    """Write an entry to the audit log table."""
    entry = models.AuditLog(
        timestamp=time.time(),
        user_id=f"USR-{user.id}" if user else None,
        username=getattr(user, "username", None) if user else None,
        action=action,
        detail=detail[:2000] if detail else "",
    )
    db.add(entry)
    try:
        db.commit()
    except Exception:
        db.rollback()


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


def _start_generation_job(job_id: int, background_tasks: Optional["BackgroundTasks"] = None):
    """Schedule the mapping generation job.

    When called from a sync endpoint, pass a BackgroundTasks instance.
    When called from an async endpoint, the running loop is used directly.
    """
    if background_tasks is not None:
        background_tasks.add_task(_run_mapping_generation_async, job_id)
    else:
        # Called from an async context (e.g. sync_state)
        loop = asyncio.get_running_loop()
        loop.create_task(_run_mapping_generation_async(job_id))


async def _run_mapping_generation_async(job_id: int):
    """Acquire async lock and run the CPU-bound generation in a thread pool executor."""
    async with _generation_lock:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, _run_mapping_generation_job, job_id)
        # Broadcast terminal status from persisted job row.
        status = "failed"
        db = SessionLocal()
        try:
            finished_job = db.query(models.MappingGenerationJob).filter(models.MappingGenerationJob.id == job_id).first()
            if finished_job and finished_job.status:
                status = finished_job.status
        finally:
            db.close()
        await broadcast_generation_progress({"jobId": job_id, "status": status})


def _run_mapping_generation_job(job_id: int):
    """Generate workspace mappings from BOM + global mappings in the background."""
    db = SessionLocal()
    scan_db = SessionLocal()
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
            for row_id, item_id in scan_db.query(models.BomItem.id, models.BomItem.item_id).all()
        }

        mapping_by_feature: Dict[str, models.GlobalMapping] = {}
        for mapping in scan_db.query(models.GlobalMapping).all():
            for feature_id in (getattr(mapping, "legacy_feature_ids", []) or []):
                normalized = str(feature_id or "").strip()
                if normalized and normalized not in mapping_by_feature:
                    mapping_by_feature[normalized] = mapping

        total_features = int(scan_db.query(func.count(models.BomFeature.id)).scalar() or 0)
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

        def flush_rows(commit_after_insert: bool = False):
            nonlocal rows_batch
            if not rows_batch:
                return

            attempts = 0
            while True:
                try:
                    db.bulk_insert_mappings(models.WorkspaceMapping, rows_batch)
                    rows_batch = []
                    if commit_after_insert:
                        db.commit()
                    return
                except OperationalError as exc:
                    db.rollback()
                    attempts += 1
                    if "database is locked" not in str(exc).lower() or attempts >= GENERATION_INSERT_MAX_RETRIES:
                        raise
                    time.sleep(0.25 * attempts)

        def append_row(row: Dict[str, Any]):
            rows_batch.append(row)
            # Flush immediately when threshold is reached so a single feature
            # with many values cannot produce one giant INSERT statement.
            if len(rows_batch) >= GENERATION_INSERT_BATCH_SIZE:
                flush_rows(commit_after_insert=True)

        for feat in scan_db.query(models.BomFeature).yield_per(1000):
            legacy_item_id = item_id_by_pk.get(getattr(feat, "item_id", None))
            if not legacy_item_id:
                processed_features += 1
                continue

            mapping = mapping_by_feature.get(str(getattr(feat, "feature_id", "") or "").strip())
            target_attr = (getattr(mapping, "new_attribute_id", "") or "").strip() or "UNMAPPED"
            attr_type = (getattr(mapping, "attribute_type", "") or "").strip() if mapping else ""
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
                append_row(
                    {
                        "legacy_item_id": legacy_item_id,
                        "legacy_feature_id": getattr(feat, "feature_id", "") or "",
                        "legacy_value": "",
                        "new_attribute_id": target_attr,
                        "new_value": "",
                        "attribute_type": attr_type,
                        "mapped_from": "global",
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
                    append_row(
                        {
                            "legacy_item_id": legacy_item_id,
                            "legacy_feature_id": getattr(feat, "feature_id", "") or "",
                            "legacy_value": str(legacy_value),
                            "new_attribute_id": target_attr,
                            "new_value": (resolved or ""),
                            "attribute_type": attr_type,
                            "mapped_from": "global" if resolved else "",
                            "signed_on_by_user_id": job.triggered_by_user_id,
                            "signed_on_by_username": job.triggered_by_username,
                            "signed_on_at": signed_ts,
                            "updated_at": time.time(),
                        }
                    )
                    generated_rows += 1
                total_values += len(values)

            processed_features += 1

            if processed_features % 250 == 0:
                flush_rows(commit_after_insert=False)
                job.processed_features = processed_features
                job.total_values = total_values
                job.processed_values = total_values
                job.generated_rows = generated_rows
                job.updated_at = time.time()
                db.commit()

        flush_rows(commit_after_insert=False)
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
        logger.exception("mapping generation failed for job=%s: %s", job_id, exc)

        # Use a fresh session for failure persistence so we don't depend on the
        # transactional state of the worker session after a DB error.
        fail_db = SessionLocal()
        try:
            failed_job = fail_db.query(models.MappingGenerationJob).filter(models.MappingGenerationJob.id == job_id).first()
            if failed_job:
                failed_job.status = "failed"
                failed_job.error_message = str(exc)
                failed_job.finished_at = time.time()
                failed_job.updated_at = failed_job.finished_at
                fail_db.commit()
        except Exception:
            fail_db.rollback()
        finally:
            fail_db.close()
    finally:
        scan_db.close()
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


@router.post("/mapping-generation/trigger")
def trigger_mapping_generation(
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Re-trigger workspace mapping generation from current BOM + global mappings."""
    try:
        _cleanup_stale_generation_jobs(db)
        active_job = (
            db.query(models.MappingGenerationJob)
            .filter(models.MappingGenerationJob.status.in_(["queued", "running"]))
            .order_by(models.MappingGenerationJob.updated_at.desc(), models.MappingGenerationJob.id.desc())
            .first()
        )
        if active_job:
            return {"ok": True, "mappingGenerationJobId": int(active_job.id)}

        queued_job = models.MappingGenerationJob(
            status="queued",
            triggered_by_user_id=f"USR-{current_user.id}",
            triggered_by_username=getattr(current_user, "username", None),
            trigger_source="manual_retrigger",
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
        db.add(queued_job)
        db.commit()
        db.refresh(queued_job)
        job_id = int(queued_job.id)
        _start_generation_job(job_id, background_tasks=background_tasks)
        invalidate_metrics_cache()
        return {"ok": True, "mappingGenerationJobId": job_id}
    except Exception as exc:
        logger.exception("trigger_mapping_generation failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

@router.get("/mapping-generation/progress")
def get_mapping_generation_progress(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    # Any authenticated user can view live generation progress.
    try:
        _cleanup_stale_generation_jobs(db)
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
    # Any authenticated user may read workspace mappings for an item.
    # Write access (PUT) still enforces lock ownership separately.

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
            "attributeType": (row.attribute_type or "").strip(),
            "mappedFrom": (row.mapped_from or "").strip() or "global",
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
def get_state(
    include_bom: bool = Query(True),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
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

    # --- Local mappings are now loaded lazily per-item via
    #     GET /workspace-mappings/{item_id} to avoid materialising millions
    #     of rows on every /state call. ------------------------------------------
    state["localMappings"] = {}

    return state


BLANK_SENTINEL = "(blank)"


def _apply_bom_category_filter(query, category: Optional[str]):
    """Apply category filter, treating BLANK_SENTINEL as NULL/empty."""
    if not category:
        return query
    if category == BLANK_SENTINEL:
        return query.filter(
            or_(models.BomItem.category == None, models.BomItem.category == "")  # noqa: E711
        )
    return query.filter(models.BomItem.category == category)


def _apply_bom_product_type_filter(query, product_type: Optional[str]):
    """Apply product_type filter, treating BLANK_SENTINEL as NULL/empty."""
    if not product_type:
        return query
    if product_type == BLANK_SENTINEL:
        return query.filter(
            or_(models.BomItem.product_type == None, models.BomItem.product_type == "")  # noqa: E711
        )
    return query.filter(models.BomItem.product_type == product_type)


@router.get("/bom/filters")
def get_bom_filters(
    category: Optional[str] = None,
    productType: Optional[str] = None,
    productLine: Optional[str] = Query(None, alias="productLine"),
    db: Session = Depends(get_db),
):
    selected_product_type = productType or productLine

    # For categories: filter by selected product type only (not by category itself)
    cat_query = db.query(models.BomItem)
    cat_query = _apply_bom_product_type_filter(cat_query, selected_product_type)
    categories = cat_query.with_entities(models.BomItem.category).distinct().all()

    # For product types: filter by selected category only (not by product type itself)
    pt_query = db.query(models.BomItem)
    pt_query = _apply_bom_category_filter(pt_query, category)
    product_types = pt_query.with_entities(models.BomItem.product_type).distinct().all()

    category_list = sorted({c[0] for c in categories if c and c[0]})
    product_type_list = sorted({p[0] for p in product_types if p and p[0]})

    # Include (blank) sentinel when items with NULL/empty values exist
    has_blank_category = any((c[0] is None or c[0] == "") for c in categories)
    has_blank_product_type = any((p[0] is None or p[0] == "") for p in product_types)
    if has_blank_category:
        category_list.insert(0, BLANK_SENTINEL)
    if has_blank_product_type:
        product_type_list.insert(0, BLANK_SENTINEL)

    return {"categories": category_list, "productTypes": product_type_list}


@router.get("/bom/count")
def get_bom_count(
    category: Optional[str] = None,
    productType: Optional[str] = None,
    search: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Return only the total count of BOM items matching the filter — no feature data."""
    search = _validate_search(search)
    query = db.query(func.count(models.BomItem.id))
    query = _apply_bom_category_filter(query, category)
    query = _apply_bom_product_type_filter(query, productType)
    if search:
        like = f"%{search}%"
        query = query.filter(
            or_(
                models.BomItem.item_id.ilike(like),
                models.BomItem.description.ilike(like),
            )
        )
    total = query.scalar() or 0
    return {"total": total}


# ---------------------------------------------------------------------------
# Lightweight init endpoint — replaces monolithic /state on login
# ---------------------------------------------------------------------------
@router.get("/init")
def get_init(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return only locks, users, and config — no BOM, mappings, or classifications."""
    # Locks from dedicated table
    all_locks = db.query(models.ItemLock).all()
    locks_dict: Dict[str, Any] = {}
    for lock in all_locks:
        locks_dict[lock.item_id] = {
            "itemId": lock.item_id,
            "userId": lock.user_id,
            "userName": lock.user_name or "",
            "timestamp": lock.acquired_at * 1000,
        }

    # Users from DB
    db_users = db.query(models.User).all()
    users_list = [
        {
            "userId": f"USR-{u.id}",
            "userName": u.username,
            "password": "",
            "role": u.role or "user",
        }
        for u in db_users
    ]

    # Config from AppState JSON
    record = db.query(models.AppState).filter(models.AppState.id == 1).first()
    state_json = dict(record.state) if record and record.state else {}
    mapping_type_config = state_json.get("mappingTypeConfig")
    item_classifications = state_json.get("itemClassifications") or {}

    return {
        "locks": locks_dict,
        "users": users_list,
        "mappingTypeConfig": mapping_type_config,
        "itemClassifications": item_classifications,
    }


# ---------------------------------------------------------------------------
# Signed-on BOM items endpoint — priority: locked items, fallback: unlocked
# ---------------------------------------------------------------------------
@router.get("/bom/signed-on")
def get_bom_signed_on(
    category: Optional[str] = None,
    productType: Optional[str] = None,
    userId: Optional[str] = None,
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return BOM items the user has signed on to, with fallback to unlocked items."""
    is_admin = getattr(current_user, "role", "user") == "admin"
    current_user_id = f"USR-{current_user.id}"

    # Determine which user's locks to query
    target_user_id = userId if (is_admin and userId) else current_user_id

    # Get locked item_ids for target user
    lock_query = db.query(models.ItemLock.item_id)
    if not (is_admin and not userId):
        # Filter by user unless admin with no userId filter (show all locks)
        lock_query = lock_query.filter(models.ItemLock.user_id == target_user_id)
    locked_item_ids = [row[0] for row in lock_query.all()]

    signed_on_count = 0
    bom_items = []

    if locked_item_ids:
        # Build query for locked items
        query = (
            db.query(models.BomItem)
            .options(selectinload(models.BomItem.features))
            .filter(models.BomItem.item_id.in_(locked_item_ids))
        )
        query = _apply_bom_category_filter(query, category)
        query = _apply_bom_product_type_filter(query, productType)
        signed_on_count = query.count()
        query = query.order_by(models.BomItem.item_id).offset(offset).limit(limit)
        bom_items = query.all()

    # Fallback: if no signed-on items (after filter), load unlocked items
    if not bom_items:
        all_locked_ids = [row[0] for row in db.query(models.ItemLock.item_id).all()]
        fallback_query = db.query(models.BomItem).options(selectinload(models.BomItem.features))
        if all_locked_ids:
            fallback_query = fallback_query.filter(~models.BomItem.item_id.in_(all_locked_ids))
        fallback_query = _apply_bom_category_filter(fallback_query, category)
        fallback_query = _apply_bom_product_type_filter(fallback_query, productType)
        fallback_query = fallback_query.order_by(models.BomItem.item_id).offset(offset).limit(limit)
        bom_items = fallback_query.all()

    return {
        "items": _build_bom_payload(bom_items),
        "signedOnCount": signed_on_count,
    }


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
    search: Optional[str] = None,
    limit: int = Query(20, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    search = _validate_search(search)
    query = db.query(models.BomItem).options(selectinload(models.BomItem.features))
    query = _apply_bom_category_filter(query, category)
    query = _apply_bom_product_type_filter(query, productType)
    if search:
        like = f"%{search}%"
        query = query.filter(
            or_(
                models.BomItem.item_id.ilike(like),
                models.BomItem.description.ilike(like),
            )
        )

    query = query.order_by(models.BomItem.item_id)
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
async def sync_state(payload: StateIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # when classifications are persisted separately we ignore that property on sync requests
    incoming = dict(payload.state)
    incoming.pop("classifications", None)

    # Phase 0.3: Admin role check for destructive operations (BOM, mappings, classifications)
    is_admin = getattr(current_user, "role", "user") == "admin"
    bom_key_present = "bom" in incoming
    if not is_admin:
        if bom_key_present and incoming.get("bom") is not None:
            raise HTTPException(status_code=403, detail="Only admins may sync BOM data")
        if "mappings" in incoming and incoming.get("mappings"):
            raise HTTPException(status_code=403, detail="Only admins may sync global mappings")

    # peel off BOM, mappings and localMappings so they are stored in dedicated tables
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
                            "values": composite_values,
                        }
                    )

            if bom_feature_rows:
                db.bulk_insert_mappings(models.BomFeature, bom_feature_rows)

    # Replace global mappings
    db.query(models.GlobalMapping).delete()
    global_mappings_to_add: List[Dict[str, Any]] = []
    current_user_id = f"USR-{current_user.id}"
    now_ts = time.time()
    for m in mappings_payload:
        raw_attr_type = m.get("attributeType")
        attr_type = str(raw_attr_type).strip().lower() if raw_attr_type is not None else ""
        global_mappings_to_add.append(
            {
                "legacy_feature_ids": m.get("legacyFeatureIds") or [],
                "new_attribute_id": m.get("newAttributeId") or "",
                "attribute_type": attr_type,
                "value_mappings": m.get("valueMappings") or {},
                "version": int(m.get("version") or 1),
                "created_by": m.get("createdBy") or current_user_id,
                "modified_by": current_user_id,
                "modified_at": now_ts,
            }
        )
    if global_mappings_to_add:
        db.bulk_insert_mappings(models.GlobalMapping, global_mappings_to_add)

    # Replace workspace mappings (source-of-truth for per-item value overrides)
    db.query(models.WorkspaceMapping).delete()

    signed_ts = time.time()
    workspace_rows_to_add: List[Dict[str, Any]] = []
    for item_id, mappings_for_item in (local_mappings_payload or {}).items():
        if not item_id:
            continue

        for m in mappings_for_item or []:
            legacy_ids = m.get("legacyFeatureIds") or []
            new_attr = m.get("newAttributeId") or ""
            values_map = m.get("valueMappings") or {}
            attr_type = str(m.get("attributeType") or "").strip().lower()

            for legacy_attr in legacy_ids:
                if not values_map:
                    workspace_rows_to_add.append(
                        {
                            "legacy_item_id": item_id,
                            "legacy_feature_id": legacy_attr,
                            "legacy_value": "",
                            "new_attribute_id": new_attr,
                            "new_value": "",
                            "attribute_type": attr_type,
                            "mapped_from": str(m.get("mappedFrom") or "local"),
                            "signed_on_by_user_id": current_user_id,
                            "signed_on_by_username": getattr(current_user, "username", None),
                            "signed_on_at": signed_ts,
                            "updated_at": now_ts,
                            "version": 1,
                            "created_by": current_user_id,
                            "modified_by": current_user_id,
                            "modified_at": now_ts,
                        }
                    )
                    continue

                for legacy_val, new_val in values_map.items():
                    if legacy_attr and legacy_val is not None:
                        workspace_rows_to_add.append(
                            {
                                "legacy_item_id": item_id,
                                "legacy_feature_id": legacy_attr,
                                "legacy_value": str(legacy_val),
                                "new_attribute_id": new_attr,
                                "new_value": str(new_val),
                                "attribute_type": attr_type,
                                "mapped_from": str(m.get("mappedFrom") or "local"),
                                "signed_on_by_user_id": current_user_id,
                                "signed_on_by_username": getattr(current_user, "username", None),
                                "signed_on_at": signed_ts,
                                "updated_at": now_ts,
                                "version": 1,
                                "created_by": current_user_id,
                                "modified_by": current_user_id,
                                "modified_at": now_ts,
                            }
                        )

    if workspace_rows_to_add:
        db.bulk_insert_mappings(models.WorkspaceMapping, workspace_rows_to_add)

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
            _cleanup_stale_generation_jobs(post_db)
            active_job = (
                post_db.query(models.MappingGenerationJob)
                .filter(models.MappingGenerationJob.status.in_(["queued", "running"]))
                .order_by(models.MappingGenerationJob.updated_at.desc(), models.MappingGenerationJob.id.desc())
                .first()
            )
            if active_job:
                mapping_generation_job_id = int(active_job.id)
            else:
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
    await broadcast_sync(actor_id=f"USR-{current_user.id}")
    return {"ok": True, "mappingGenerationJobId": mapping_generation_job_id}

@router.post("/lock")
async def handle_lock(
    action_payload: Dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Acquire or release an item-level edit lock using database-backed atomic locking."""
    action = action_payload.get("action")
    itemId = action_payload.get("itemId")
    if not itemId or not action:
        raise HTTPException(status_code=400, detail="itemId and action required")

    current_user_id = f"USR-{current_user.id}"

    # Validate userId matches current_user (prevent impersonation)
    payload_user_id = action_payload.get("userId")
    if action in ("acquire", "release") and payload_user_id and payload_user_id != current_user_id:
        raise HTTPException(status_code=403, detail="userId does not match authenticated user")

    response_payload: Dict[str, Any] = {"ok": True}

    if action == "acquire":
        userName = action_payload.get("userName") or getattr(current_user, "username", "")
        existing = db.query(models.ItemLock).filter(models.ItemLock.item_id == itemId).first()
        if existing and existing.user_id != current_user_id:
            return {"acquired": False, "reason": "locked"}
        if existing and existing.user_id == current_user_id:
            # Already hold this lock — idempotent success
            response_payload = {"acquired": True}
        else:
            user_lock_count = db.query(func.count(models.ItemLock.id)).filter(
                models.ItemLock.user_id == current_user_id
            ).scalar() or 0
            if user_lock_count >= 2:
                return {"acquired": False, "reason": "limit"}
            try:
                new_lock = models.ItemLock(
                    item_id=itemId,
                    user_id=current_user_id,
                    user_name=userName,
                    acquired_at=time.time(),
                )
                db.add(new_lock)
                db.flush()
                response_payload = {"acquired": True}
            except IntegrityError:
                db.rollback()
                return {"acquired": False, "reason": "locked"}

    elif action == "release":
        lock = db.query(models.ItemLock).filter(
            models.ItemLock.item_id == itemId,
            models.ItemLock.user_id == current_user_id,
        ).first()
        if lock:
            db.delete(lock)
            logger.info("Lock released: item=%s user=%s", itemId, current_user_id)

    elif action == "force-release":
        if getattr(current_user, "role", "user") != "admin":
            raise HTTPException(status_code=403, detail="Only admins may force-release locks")
        lock = db.query(models.ItemLock).filter(models.ItemLock.item_id == itemId).first()
        if lock:
            db.delete(lock)
            _audit(db, current_user, "force-release-lock", f"item={itemId}")
            logger.info("Lock force-released by admin: item=%s admin=%s", itemId, current_user_id)

    else:
        raise HTTPException(status_code=400, detail="unknown action")

    # Also update the AppState JSON locks for backward compatibility with
    # /state endpoint consumers that read locks from the JSON blob.
    _sync_locks_to_app_state(db)
    db.commit()

    # Broadcast lock change to all connected WebSocket clients
    lock_info = None
    if action == "acquire" and response_payload.get("acquired"):
        lock_info = {
            "itemId": itemId,
            "userId": current_user_id,
            "userName": action_payload.get("userName") or getattr(current_user, "username", ""),
            "timestamp": time.time() * 1000,
        }
    await broadcast_lock_change(itemId, lock_info, actor_id=current_user_id)

    return response_payload


def _sync_locks_to_app_state(db: Session):
    """Rebuild the locks dict in AppState JSON from the item_locks table."""
    all_locks = db.query(models.ItemLock).all()
    locks_dict = {}
    for lock in all_locks:
        locks_dict[lock.item_id] = {
            "itemId": lock.item_id,
            "userId": lock.user_id,
            "userName": lock.user_name or "",
            "timestamp": lock.acquired_at * 1000,
        }
    record = db.query(models.AppState).filter(models.AppState.id == 1).first()
    if not record:
        record = models.AppState(id=1, state={"locks": locks_dict})
        db.add(record)
    else:
        state = dict(record.state) if record.state else {}
        state["locks"] = locks_dict
        record.state = state


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

    # --- check cache (cache both variants from one computation) ---
    cache_key = _make_metrics_cache_key(category, selected_product_type, includeExcluded)
    fingerprint = _data_fingerprint(db)

    if not forceRecompute and cache_key in _metrics_cache and _metrics_cache_fingerprint.get(cache_key) == fingerprint:
        return _metrics_cache[cache_key]

    # --- Get included attribute types from mappingTypeConfig ---
    state_record = db.query(models.AppState).filter(models.AppState.id == 1).first()
    state_payload = dict(state_record.state) if state_record and state_record.state else {}
    mapping_type_config = state_payload.get("mappingTypeConfig") or {}
    available_types = [str(v).strip().lower() for v in (mapping_type_config.get("availableTypes") or []) if str(v).strip()]
    included_types = [str(v).strip().lower() for v in (mapping_type_config.get("includedTypes") or []) if str(v).strip()]
    included_type_set = set(included_types if included_types else available_types) if available_types else None

    # --- Get BOM items matching filters (lightweight: no features loaded) ---
    items_query = db.query(
        models.BomItem.item_id,
        models.BomItem.description,
        models.BomItem.category,
        models.BomItem.product_type,
    )
    if category:
        items_query = items_query.filter(models.BomItem.category == category)
    if selected_product_type:
        items_query = items_query.filter(models.BomItem.product_type == selected_product_type)
    bom_rows = items_query.order_by(models.BomItem.item_id).all()

    if not bom_rows:
        empty = {
            "totals": {"items": 0, "features": 0, "values": 0},
            "mapped": {"features": 0, "values": 0, "items": 0, "notRequiredFeatures": 0},
            "excluded": {"features": 0, "values": 0},
            "coverage": {"attribute": 0.0, "value": 0.0, "item": 0.0},
            "includeExcluded": bool(includeExcluded),
            "items": [],
        }
        _metrics_cache[cache_key] = empty
        _metrics_cache_fingerprint[cache_key] = fingerprint
        return empty

    bom_info: Dict[str, Dict[str, str]] = {}
    for r in bom_rows:
        bom_info[r.item_id] = {
            "description": r.description or "",
            "category": r.category or "",
            "productType": r.product_type or "",
        }
    item_ids = list(bom_info.keys())

    # --- SQL aggregation on workspace_mappings: one row per (item, feature) ---
    from sqlalchemy import text as sa_text, literal_column

    # Use a subquery to filter workspace_mappings by matching bom_items
    # This pushes all heavy lifting into the database engine.
    filter_clause = "1=1"
    bind_params: Dict[str, Any] = {}
    if category:
        filter_clause += " AND bi.category = :category"
        bind_params["category"] = category
    if selected_product_type:
        filter_clause += " AND bi.product_type = :product_type"
        bind_params["product_type"] = selected_product_type

    agg_sql = sa_text(f"""
        SELECT
            wm.legacy_item_id,
            wm.legacy_feature_id,
            COALESCE(wm.attribute_type, '') AS attribute_type,
            COALESCE(wm.new_attribute_id, '') AS new_attribute_id,
            COUNT(*) AS total_values,
            SUM(CASE WHEN wm.new_value IS NOT NULL AND wm.new_value != '' THEN 1 ELSE 0 END) AS mapped_values
        FROM workspace_mappings wm
        INNER JOIN bom_items bi ON bi.item_id = wm.legacy_item_id
        WHERE {filter_clause}
        GROUP BY wm.legacy_item_id, wm.legacy_feature_id, wm.attribute_type, wm.new_attribute_id
    """)
    ws_rows = db.execute(agg_sql, bind_params).fetchall()

    # --- Accumulate stats from pre-aggregated rows ---
    per_item: Dict[str, Dict[str, int]] = {iid: {
        "total": 0, "mapped": 0, "not_required": 0, "excluded": 0,
        "total_vals": 0, "mapped_vals": 0, "excluded_vals": 0,
    } for iid in item_ids}

    total_features = 0
    mapped_features = 0
    total_values = 0
    mapped_values = 0
    not_required_features = 0
    excluded_features = 0
    excluded_values = 0

    for row in ws_rows:
        item_id = row.legacy_item_id
        if item_id not in per_item:
            continue
        stats = per_item[item_id]

        attr_type = (row.attribute_type or "").strip().lower()
        new_attr = (row.new_attribute_id or "").strip().upper()
        num_values = int(row.total_values)
        num_mapped = int(row.mapped_values)
        is_excluded = bool(included_type_set and attr_type and attr_type not in included_type_set)

        stats["total"] += 1
        total_features += 1

        if is_excluded:
            stats["excluded"] += 1
            excluded_features += 1
            stats["excluded_vals"] += num_values
            excluded_values += num_values
            if not includeExcluded:
                stats["total"] -= 1
                total_features -= 1
                # Ignore values for excluded/unchecked attributes
                continue

        if new_attr == "NOT REQUIRED":
            stats["not_required"] += 1
            not_required_features += 1
        elif new_attr and new_attr != "UNMAPPED":
            stats["mapped"] += 1
            mapped_features += 1

        stats["total_vals"] += num_values
        total_values += num_values
        stats["mapped_vals"] += num_mapped
        mapped_values += num_mapped

    items_fully_mapped = 0
    item_rows: List[Dict[str, Any]] = []

    for iid in item_ids:
        s = per_item[iid]
        info = bom_info[iid]
        mappable = max(0, s["total"] - s["not_required"])
        attr_complete = mappable == 0 or s["mapped"] >= mappable
        vals_complete = s["total_vals"] == 0 or s["mapped_vals"] >= s["total_vals"]
        fully = attr_complete and vals_complete
        if fully:
            items_fully_mapped += 1
        item_rows.append({
            "itemId": iid,
            "description": info["description"],
            "category": info["category"],
            "productType": info["productType"],
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
    item_coverage = (items_fully_mapped / len(bom_rows)) if bom_rows else 0

    result = {
        "totals": {
            "items": int(len(bom_rows)),
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
        # Build the set of included mapping types so we can skip ignored features.
        state_record = db.query(models.AppState).filter(models.AppState.id == 1).first()
        state_payload = dict(state_record.state) if state_record and state_record.state else {}
        mapping_type_config = state_payload.get("mappingTypeConfig") or {}
        available_types = [str(v).strip().lower() for v in (mapping_type_config.get("availableTypes") or []) if str(v).strip()]
        included_types = [str(v).strip().lower() for v in (mapping_type_config.get("includedTypes") or []) if str(v).strip()]
        included_type_set = set(included_types if included_types else available_types) if available_types else None

        # Build per-feature mapping lookup
        mapping_by_feature: Dict[str, models.GlobalMapping] = {}
        for mapping in db.query(models.GlobalMapping).all():
                for fid in (getattr(mapping, "legacy_feature_ids", []) or []):
                        normalized = str(fid or "").strip()
                        if normalized and normalized not in mapping_by_feature:
                                mapping_by_feature[normalized] = mapping

        # Compute per-item status in Python so we can apply the ignore filter
        item_stats: Dict[str, Dict[str, int]] = {}
        item_pks = {pk: item_id for pk, item_id in db.query(models.BomItem.id, models.BomItem.item_id).all()}

        for item_id in item_pks.values():
                item_stats[item_id] = {"mapped": 0, "not_required": 0, "total": 0}

        BATCH = 5000
        pk_list = list(item_pks.keys())
        for i in range(0, len(pk_list), BATCH):
                batch = pk_list[i:i + BATCH]
                features = db.query(models.BomFeature).filter(models.BomFeature.item_id.in_(batch)).all()
                for feat in features:
                        item_id = item_pks.get(feat.item_id)
                        if not item_id:
                                continue
                        gm = mapping_by_feature.get(str(feat.feature_id or "").strip())
                        attr_type = (getattr(gm, "attribute_type", "") or "").strip().lower() if gm else ""
                        # Skip features whose attribute type is excluded (IGNORE group)
                        if included_type_set and attr_type and attr_type not in included_type_set:
                                continue
                        target = (getattr(gm, "new_attribute_id", "") or "").strip().upper() if gm else ""
                        stats = item_stats[item_id]
                        stats["total"] += 1
                        if target == "NOT REQUIRED":
                                stats["not_required"] += 1
                        elif target and target != "UNMAPPED":
                                stats["mapped"] += 1

        statuses: Dict[str, str] = {}
        for item_id, s in item_stats.items():
                total = s["total"]
                mapped = s["mapped"]
                not_required = s["not_required"]

                if total == 0:
                        statuses[item_id] = "notRequired"
                elif mapped + not_required >= total and mapped > 0:
                        statuses[item_id] = "mapped"
                elif mapped == 0 and not_required >= total:
                        statuses[item_id] = "notRequired"
                else:
                        statuses[item_id] = "unmapped"

        return {"statuses": statuses}


@router.get("/export/bom-csv")
def export_bom_csv(
        category: Optional[str] = None,
        productType: Optional[str] = None,
        search: Optional[str] = None,
        db: Session = Depends(get_db),
        current_user: models.User = Depends(get_current_user),
):
        if getattr(current_user, "role", "user") != "admin":
                raise HTTPException(status_code=403, detail="admin role required to export BOM data")
        search = _validate_search(search)
        _audit(db, current_user, "export-bom-csv", f"category={category} productType={productType} search={search}")

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

                items_query = db.query(models.BomItem).options(selectinload(models.BomItem.features))
                items_query = _apply_bom_category_filter(items_query, category)
                items_query = _apply_bom_product_type_filter(items_query, productType)
                if search:
                        like = f"%{search}%"
                        items_query = items_query.filter(
                                or_(models.BomItem.item_id.ilike(like), models.BomItem.description.ilike(like))
                        )
                items = items_query.all()

                mapping_rows = db.query(models.GlobalMapping).all()
                by_feature: Dict[str, models.GlobalMapping] = {}
                for m in mapping_rows:
                        for fid in getattr(m, "legacy_feature_ids", []) or []:
                                if fid and fid not in by_feature:
                                        by_feature[fid] = m

                row_count = 0
                for item in items:
                        for feature in item.features:
                                if row_count >= MAX_EXPORT_ROWS:
                                        writer.writerow(["--- TRUNCATED ---", f"Export capped at {MAX_EXPORT_ROWS} rows", "", "", "", "", ""])
                                        yield output.getvalue()
                                        output.seek(0)
                                        output.truncate(0)
                                        return

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
                                        row_count += 1
                                        continue

                                for v in values:
                                        if row_count >= MAX_EXPORT_ROWS:
                                                break
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
                                        row_count += 1

        filename = "bom_export.csv"
        headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
        return StreamingResponse(iter_rows(), media_type="text/csv", headers=headers)


@router.get("/export/classifications-csv")
def export_classifications_csv(
        search: Optional[str] = None,
        classId: Optional[str] = None,
        db: Session = Depends(get_db),
        current_user: models.User = Depends(get_current_user),
):
        if getattr(current_user, "role", "user") != "admin":
                raise HTTPException(status_code=403, detail="admin role required")
        search = _validate_search(search)
        _audit(db, current_user, "export-classifications-csv", f"classId={classId} search={search}")

        def iter_rows():
                output = io.StringIO()
                writer = csv.writer(output)
                writer.writerow(["Class ID", "Class Name", "Attribute ID", "Description", "Unit", "Allowed Values", "Value Descriptions"])
                yield output.getvalue()
                output.seek(0)
                output.truncate(0)

                query = db.query(models.Classification)
                if classId:
                        query = query.filter(models.Classification.class_id == classId)
                if search:
                        like = f"%{search}%"
                        query = query.filter(or_(
                                models.Classification.class_id.ilike(like),
                                models.Classification.class_name.ilike(like),
                        ))

                row_count = 0
                for cls in query.order_by(models.Classification.class_id).all():
                        for attr in (cls.attributes or []):
                                if row_count >= MAX_EXPORT_ROWS:
                                        writer.writerow(["--- TRUNCATED ---", f"Export capped at {MAX_EXPORT_ROWS} rows", "", "", "", "", ""])
                                        yield output.getvalue()
                                        return
                                allowed = ";".join(attr.get("allowedValues") or [])
                                vd = attr.get("valueDescriptions") or {}
                                vd_str = ";".join(f"{k}={v}" for k, v in vd.items()) if vd else ""
                                writer.writerow([
                                        cls.class_id,
                                        cls.class_name or "",
                                        attr.get("attributeId", ""),
                                        attr.get("description", ""),
                                        attr.get("unit", ""),
                                        allowed,
                                        vd_str,
                                ])
                                yield output.getvalue()
                                output.seek(0)
                                output.truncate(0)
                                row_count += 1

        headers = {"Content-Disposition": 'attachment; filename="classifications_export.csv"'}
        return StreamingResponse(iter_rows(), media_type="text/csv", headers=headers)


@router.get("/export/valuelists-csv")
def export_valuelists_csv(
        search: Optional[str] = None,
        valuelistId: Optional[str] = None,
        db: Session = Depends(get_db),
        current_user: models.User = Depends(get_current_user),
):
        if getattr(current_user, "role", "user") != "admin":
                raise HTTPException(status_code=403, detail="admin role required")
        search = _validate_search(search)
        _audit(db, current_user, "export-valuelists-csv", f"valuelistId={valuelistId} search={search}")

        def iter_rows():
                output = io.StringIO()
                writer = csv.writer(output)
                writer.writerow(["Valuelist ID", "Valuelist Description", "Unit", "Value", "Value Description"])
                yield output.getvalue()
                output.seek(0)
                output.truncate(0)

                query = db.query(models.ValueList)
                if valuelistId:
                        query = query.filter(models.ValueList.valuelist_id == valuelistId)
                if search:
                        like = f"%{search}%"
                        query = query.filter(or_(
                                models.ValueList.valuelist_id.ilike(like),
                                models.ValueList.valuelist_id_description.ilike(like),
                                models.ValueList.value.ilike(like),
                        ))

                row_count = 0
                for row in query.order_by(models.ValueList.valuelist_id, models.ValueList.value).all():
                        if row_count >= MAX_EXPORT_ROWS:
                                writer.writerow(["--- TRUNCATED ---", f"Export capped at {MAX_EXPORT_ROWS} rows", "", "", ""])
                                yield output.getvalue()
                                return
                        writer.writerow([
                                row.valuelist_id,
                                row.valuelist_id_description or "",
                                row.unit or "",
                                row.value,
                                row.value_description or "",
                        ])
                        yield output.getvalue()
                        output.seek(0)
                        output.truncate(0)
                        row_count += 1

        headers = {"Content-Disposition": 'attachment; filename="valuelists_export.csv"'}
        return StreamingResponse(iter_rows(), media_type="text/csv", headers=headers)

@router.post("/wipe-bom")
def wipe_bom(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Delete all BOM items and features (leaves mappings intact)."""
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="admin role required to wipe BOM data")
    _audit(db, current_user, "wipe-bom", "")
    db.query(models.BomFeature).delete()
    db.query(models.BomItem).delete()
    db.commit()
    invalidate_metrics_cache()
    return {"ok": True}


@router.get("/global-mappings")
def list_global_mappings(
    search: Optional[str] = None,
    limit: int = Query(20, ge=0, le=5000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    """Paginated listing of global mappings with optional search."""
    search = _validate_search(search)
    query = db.query(models.GlobalMapping)

    if search:
        like = f"%{search}%"
        query = query.filter(
            or_(
                models.GlobalMapping.new_attribute_id.ilike(like),
                models.GlobalMapping.attribute_type.ilike(like),
                cast(models.GlobalMapping.legacy_feature_ids, String).ilike(like),
            )
        )

    total = query.count()

    query = query.order_by(models.GlobalMapping.id)
    if limit:
        query = query.offset(offset).limit(limit)

    rows = query.all()
    items = [
        {
            "legacyFeatureIds": getattr(m, "legacy_feature_ids", []) or [],
            "newAttributeId": getattr(m, "new_attribute_id", ""),
            "attributeType": getattr(m, "attribute_type", "") or "",
            "valueMappings": getattr(m, "value_mappings", {}) or {},
            "version": getattr(m, "version", 1),
            "createdBy": getattr(m, "created_by", None),
            "modifiedBy": getattr(m, "modified_by", None),
            "modifiedAt": getattr(m, "modified_at", None),
        }
        for m in rows
    ]

    return {"items": items, "total": total}


@router.get("/classifications/paginated")
def list_classifications_paginated(
    search: Optional[str] = None,
    limit: int = Query(20, ge=0, le=5000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    """Paginated listing of classifications with optional search."""
    search = _validate_search(search)
    query = db.query(models.Classification)

    if search:
        like = f"%{search}%"
        query = query.filter(
            or_(
                models.Classification.class_id.ilike(like),
                models.Classification.class_name.ilike(like),
            )
        )

    total = query.count()

    query = query.order_by(models.Classification.class_id)
    if limit:
        query = query.offset(offset).limit(limit)

    records = query.all()
    items = [
        {
            "classId": r.class_id,
            "className": r.class_name,
            "attributes": r.attributes or [],
        }
        for r in records
    ]

    return {"items": items, "total": total}


@router.get("/classifications/filters")
def get_classification_filters(
    classId: Optional[str] = None,
    attributeId: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Return all distinct class names and attribute IDs with bidirectional cross-filtering."""
    all_records = db.query(models.Classification).order_by(models.Classification.class_id).all()

    # Build full lookup structures
    class_entries = []  # list of { classId, className, attributeIds: set }
    for r in all_records:
        attr_ids: set = set()
        for attr in (r.attributes or []):
            aid = (attr.get("attributeId") or "").strip()
            if aid:
                attr_ids.add(aid)
        class_entries.append({
            "classId": r.class_id,
            "className": r.class_name or r.class_id,
            "attributeIds": attr_ids,
        })

    # When an attribute is selected, only return classes that contain it
    if attributeId:
        target = attributeId.strip().lower()
        class_entries = [
            c for c in class_entries
            if any(a.lower() == target for a in c["attributeIds"])
        ]

    class_options = [{"classId": c["classId"], "className": c["className"]} for c in class_entries]

    # When a class is selected, only return attributes from that class
    attr_source = class_entries
    if classId:
        attr_source = [c for c in class_entries if c["classId"] == classId]

    all_attr_ids: set = set()
    for c in attr_source:
        all_attr_ids.update(c["attributeIds"])
    attribute_options = sorted(all_attr_ids, key=str.lower)

    return {"classes": class_options, "attributes": attribute_options}


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
    try:
        db.query(models.WorkspaceMapping).delete()
        db.query(models.MappingGenerationJob).delete()
    except Exception:
        pass
    db.commit()
    invalidate_metrics_cache()
    return {"ok": True}
