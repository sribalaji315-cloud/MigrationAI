from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import func, or_, cast, String
from sqlalchemy.exc import IntegrityError, OperationalError
from typing import Dict, List, Any, Optional, Set
import io, csv, time, hashlib, asyncio, logging
from ..db import models
from ..db.session import get_db, SessionLocal
from ..schemas import StateIn, ClassAttributeValuesIn
from ..core.security import get_current_user
from .websocket import broadcast_lock_change, broadcast_mapping_update, broadcast_generation_progress, broadcast_sync

logger = logging.getLogger("erp_migrator")
router = APIRouter(tags=["state"])

MAX_SEARCH_LENGTH = 100
MAX_EXPORT_ROWS = 100_000


def _get_mapping_type_config(db: Session) -> Optional[Dict[str, Any]]:
    """Read mappingTypeConfig from the app_config table (auto-derive when missing)."""
    cfg = db.query(models.AppConfig).filter(models.AppConfig.id == 1).first()
    mapping_type_config = cfg.mapping_type_config if cfg else None
    if not mapping_type_config:
        raw_types = (
            db.query(models.GlobalMapping.attribute_type)
            .filter(models.GlobalMapping.attribute_type.isnot(None))
            .filter(models.GlobalMapping.attribute_type != "")
            .distinct()
            .all()
        )
        available = sorted({(t[0] or "").strip().lower() for t in raw_types if (t[0] or "").strip()})
        if available:
            mapping_type_config = {
                "availableTypes": available,
                "includedTypes": available,
            }
    return mapping_type_config


def _get_included_type_set(db: Session) -> Optional[Set[str]]:
    """Return the set of included mapping attribute types, or None if unfiltered."""
    mapping_type_config = _get_mapping_type_config(db) or {}
    available_types = [str(v).strip().lower() for v in (mapping_type_config.get("availableTypes") or []) if str(v).strip()]
    included_types = [str(v).strip().lower() for v in (mapping_type_config.get("includedTypes") or []) if str(v).strip()]
    return set(included_types if included_types else available_types) if available_types else None

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

def _make_metrics_cache_key(category: Optional[str], product_type: Optional[str], include_excluded: bool, priority: Optional[int] = None) -> str:
    raw = f"{category or ''}|{product_type or ''}|{include_excluded}|{priority if priority is not None else ''}"
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


def _has_resolved_value_mapping(value_mappings: Dict[str, str], legacy_value: str) -> bool:
    resolved = _resolve_value_mapping(value_mappings, legacy_value)
    return resolved is not None and str(resolved).strip() != ""


def _feature_values_fully_mapped(value_mappings: Dict[str, str], raw_values: Any) -> bool:
    if isinstance(raw_values, dict):
        raw_list = raw_values.get("values") or []
    elif isinstance(raw_values, list):
        raw_list = raw_values
    else:
        raw_list = []
    values = [str(v or "") for v in raw_list if str(v or "").strip() != ""]
    if not values:
        return True
    return all(_has_resolved_value_mapping(value_mappings, legacy_value) for legacy_value in values)


def _normalize_legacy_feature_ids(raw_ids: Any) -> List[str]:
    seen = set()
    normalized: List[str] = []
    for raw in (raw_ids or []):
        value = str(raw or "").strip()
        if value and value not in seen:
            seen.add(value)
            normalized.append(value)
    normalized.sort()
    return normalized


def _normalize_value_mappings(raw_map: Any) -> Dict[str, str]:
    if not isinstance(raw_map, dict):
        return {}
    normalized: Dict[str, str] = {}
    for raw_key, raw_value in raw_map.items():
        key = str(raw_key or "").strip()
        if not key:
            continue
        normalized[key] = "" if raw_value is None else str(raw_value)
    return normalized


def _global_mapping_natural_key(legacy_feature_ids: List[str], new_attribute_id: str) -> str:
    return f"{'|'.join(legacy_feature_ids)}=>{new_attribute_id.strip()}"


def _coerce_sortable_timestamp(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("-inf")


def _global_mapping_payload_rank(row: Dict[str, Any]):
    return (
        _coerce_sortable_timestamp(row.get("client_edited_at") if row.get("client_edited_at") is not None else row.get("modified_at")),
        int(row.get("id") or 0),
        int(row.get("_sequence") or 0),
    )


def _global_mapping_model_rank(row: models.GlobalMapping):
    return (
        _coerce_sortable_timestamp(getattr(row, "modified_at", None)),
        int(getattr(row, "id", 0) or 0),
    )


def _dedupe_global_mapping_payload(rows: List[Dict[str, Any]]):
    by_key: Dict[str, Dict[str, Any]] = {}
    collapsed = 0
    for row in rows:
        natural_key = _global_mapping_natural_key(row["legacy_feature_ids"], row["new_attribute_id"])
        existing = by_key.get(natural_key)
        if existing is None:
            by_key[natural_key] = row
            continue
        collapsed += 1
        if _global_mapping_payload_rank(row) >= _global_mapping_payload_rank(existing):
            by_key[natural_key] = row
    return list(by_key.values()), collapsed


def _build_latest_mapping_by_feature(mapping_rows: List[models.GlobalMapping]) -> Dict[str, models.GlobalMapping]:
    mapping_by_feature: Dict[str, models.GlobalMapping] = {}
    for mapping in sorted(mapping_rows, key=_global_mapping_model_rank, reverse=True):
        for feature_id in (getattr(mapping, "legacy_feature_ids", []) or []):
            normalized = str(feature_id or "").strip()
            if normalized and normalized not in mapping_by_feature:
                mapping_by_feature[normalized] = mapping
    return mapping_by_feature


def _deduplicate_global_mappings_in_db(db_session) -> int:
    """Consolidate duplicate global mappings sharing the same natural key.

    For each combination of ``legacy_feature_ids`` + ``new_attribute_id`` that
    appears in multiple ``GlobalMapping`` rows, we keep only the single best
    row — preferring non-empty ``attribute_type``, then highest
    ``_global_mapping_model_rank``.

    Value-mappings from inferior duplicates are merged into the winner so no
    user work is lost.

    Returns the number of duplicate rows deleted.
    """
    all_rows = db_session.query(models.GlobalMapping).all()
    if not all_rows:
        return 0

    # Group by normalised feature-id set + new_attribute_id (the true natural key).
    by_natural_key: Dict[str, List[models.GlobalMapping]] = {}
    for row in all_rows:
        feature_ids = _normalize_legacy_feature_ids(getattr(row, "legacy_feature_ids", []) or [])
        new_attr = str(getattr(row, "new_attribute_id", "") or "").strip().lower()
        natural_key = "|".join(feature_ids) + "||" + new_attr
        by_natural_key.setdefault(natural_key, []).append(row)

    ids_to_delete: List[int] = []

    for _natural_key, group in by_natural_key.items():
        if len(group) <= 1:
            continue

        # Pick the best row: prefer non-empty attribute_type, then highest rank.
        def _sort_key(r: models.GlobalMapping):
            attr_type = str(getattr(r, "attribute_type", "") or "").strip()
            has_attr_type = 1 if attr_type else 0
            has_target = 1 if str(getattr(r, "new_attribute_id", "") or "").strip() else 0
            return (has_attr_type, has_target, _global_mapping_model_rank(r))

        group.sort(key=_sort_key, reverse=True)
        winner = group[0]

        # Merge value_mappings from losers into winner (prefer non-empty values).
        merged_values = dict(_normalize_value_mappings(getattr(winner, "value_mappings", {}) or {}))
        for loser in group[1:]:
            loser_values = _normalize_value_mappings(getattr(loser, "value_mappings", {}) or {})
            for k, v in loser_values.items():
                if k not in merged_values or (not merged_values[k] and v):
                    merged_values[k] = v
            ids_to_delete.append(int(loser.id))

        if merged_values != _normalize_value_mappings(getattr(winner, "value_mappings", {}) or {}):
            winner.value_mappings = merged_values
            winner.modified_at = time.time()

    if ids_to_delete:
        db_session.query(models.GlobalMapping).filter(
            models.GlobalMapping.id.in_(ids_to_delete)
        ).delete(synchronize_session=False)
        db_session.commit()
        logger.info("deduplicated global mappings: removed %d duplicate rows", len(ids_to_delete))

    return len(ids_to_delete)


def _global_mapping_row_changed(
    row: models.GlobalMapping,
    legacy_feature_ids: List[str],
    new_attribute_id: str,
    attribute_type: str,
    value_mappings: Dict[str, str],
) -> bool:
    existing_feature_ids = _normalize_legacy_feature_ids(getattr(row, "legacy_feature_ids", []) or [])
    existing_attr_id = str(getattr(row, "new_attribute_id", "") or "").strip()
    existing_attr_type = str(getattr(row, "attribute_type", "") or "").strip().lower()
    existing_value_mappings = _normalize_value_mappings(getattr(row, "value_mappings", {}) or {})

    return (
        existing_feature_ids != legacy_feature_ids
        or existing_attr_id != new_attribute_id
        or existing_attr_type != attribute_type
        or existing_value_mappings != value_mappings
    )


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
        # Preserve rows that were manually overridden (mapped_from == 'local').
        db.query(models.WorkspaceMapping).filter(
            models.WorkspaceMapping.mapped_from != "local"
        ).delete(synchronize_session=False)
        db.commit()

        # Collect (item_id, feature_id) pairs that have local overrides so the
        # generation loop can skip them entirely.
        _local_pairs_raw = (
            db.query(
                models.WorkspaceMapping.legacy_item_id,
                models.WorkspaceMapping.legacy_feature_id,
            )
            .filter(models.WorkspaceMapping.mapped_from == "local")
            .distinct()
            .all()
        )
        local_override_pairs: set = {(r[0], r[1]) for r in _local_pairs_raw}

        item_id_by_pk = {
            row_id: item_id
            for row_id, item_id in scan_db.query(models.BomItem.id, models.BomItem.item_id).all()
        }

        # Consolidate duplicate global mappings before building the index so
        # regeneration always starts from a clean set of rules.
        _dedup_removed = _deduplicate_global_mappings_in_db(db)

        mapping_by_feature = _build_latest_mapping_by_feature(scan_db.query(models.GlobalMapping).all())

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

            feat_feature_id = str(getattr(feat, "feature_id", "") or "").strip()

            # Skip features that have local overrides — those are user-managed.
            if (legacy_item_id, feat_feature_id) in local_override_pairs:
                processed_features += 1
                continue

            mapping = mapping_by_feature.get(feat_feature_id)
            target_attr = (getattr(mapping, "new_attribute_id", "") or "").strip() or "UNMAPPED"
            attr_type = (getattr(mapping, "attribute_type", "") or "").strip() if mapping else ""
            feat_condition = (getattr(feat, "condition", "") or "").strip() or None
            feat_formula = (getattr(feat, "formula", "") or "").strip() or None
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
                        "condition": feat_condition,
                        "formula": feat_formula,
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
                            "condition": feat_condition,
                            "formula": feat_formula,
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


# ---------------------------------------------------------------------------
# Feature-combination analysis (dedicated job + summary table)
# ---------------------------------------------------------------------------

_feature_combination_lock = asyncio.Lock()


def _normalize_feature_values(raw_values: Any) -> List[str]:
    """Return a deduplicated, sorted list of non-blank string values."""
    if isinstance(raw_values, dict):
        raw_list = raw_values.get("values") or []
    elif isinstance(raw_values, list):
        raw_list = raw_values
    else:
        raw_list = []
    seen: Set[str] = set()
    result: List[str] = []
    for v in raw_list:
        s = str(v or "").strip()
        if s and s not in seen:
            seen.add(s)
            result.append(s)
    result.sort()
    return result


def _make_values_key(sorted_values: List[str]) -> str:
    """Deterministic string key from a sorted, deduped value list."""
    return "|".join(sorted_values)


def _run_feature_combination_job(job_id: int):
    """Synchronous worker: scan BomFeature, group by feature_id+values, count items."""
    db = SessionLocal()

    def _safe_commit(session, max_retries: int = 5):
        """Retry commit on SQLite 'database is locked' errors."""
        for attempt in range(1, max_retries + 1):
            try:
                session.commit()
                return
            except OperationalError as exc:
                session.rollback()
                if "database is locked" not in str(exc).lower() or attempt >= max_retries:
                    raise
                time.sleep(0.25 * attempt)

    scan_db = None
    try:
        job = db.query(models.FeatureCombinationJob).filter(models.FeatureCombinationJob.id == job_id).first()
        if not job or job.status not in ("queued", "running"):
            return
        job.status = "running"
        job.started_at = time.time()
        job.updated_at = job.started_at
        _safe_commit(db)

        # Use a separate read session so the scan doesn't hold a write lock
        scan_db = SessionLocal()

        # Build item_id map (pk -> string item_id)
        item_id_by_pk = {
            row_id: item_id
            for row_id, item_id in scan_db.query(models.BomItem.id, models.BomItem.item_id).all()
        }

        # Build priority map (string item_id -> priority)
        priority_by_item = {
            item_id: priority
            for item_id, priority in scan_db.query(models.BomItem.item_id, models.BomItem.priority).all()
            if priority is not None
        }

        # Build feature_id -> attribute_type from global mappings
        attr_type_by_feature: Dict[str, str] = {}
        for gm in scan_db.query(models.GlobalMapping).all():
            at = (getattr(gm, "attribute_type", "") or "").strip()
            for fid in (getattr(gm, "legacy_feature_ids", []) or []):
                normalized_fid = str(fid or "").strip()
                if normalized_fid and at:
                    attr_type_by_feature.setdefault(normalized_fid, at)

        # Build feature_id -> list of { attr, vm } from global mappings (supports multiple D365 attrs per feature)
        d365_by_feature: Dict[str, List[Dict[str, Any]]] = {}
        for gm in scan_db.query(models.GlobalMapping).all():
            new_attr = (getattr(gm, "new_attribute_id", "") or "").strip()
            vm = getattr(gm, "value_mappings", None) or {}
            for fid in (getattr(gm, "legacy_feature_ids", []) or []):
                normalized_fid = str(fid or "").strip()
                if normalized_fid and new_attr:
                    d365_by_feature.setdefault(normalized_fid, []).append({"attr": new_attr, "vm": dict(vm)})

        total_features = int(scan_db.query(func.count(models.BomFeature.id)).scalar() or 0)
        job.total_features = total_features
        job.updated_at = time.time()
        _safe_commit(db)

        # combination key -> { feature_id, description, unit, values, item_ids set }
        combos: Dict[str, Dict[str, Any]] = {}
        processed = 0

        for feat in scan_db.query(models.BomFeature).yield_per(1000):
            legacy_item_id = item_id_by_pk.get(getattr(feat, "item_id", None))
            if not legacy_item_id:
                processed += 1
                continue

            feature_id = str(getattr(feat, "feature_id", "") or "").strip()
            normalized = _normalize_feature_values(getattr(feat, "values", []))
            values_key = _make_values_key(normalized)
            combo_key = f"{feature_id}||{values_key}"

            if combo_key not in combos:
                combos[combo_key] = {
                    "feature_id": feature_id,
                    "description": str(getattr(feat, "description", "") or "").strip(),
                    "unit": str(getattr(feat, "unit", "") or "").strip(),
                    "values": normalized,
                    "item_ids": set(),
                }
            combos[combo_key]["item_ids"].add(legacy_item_id)
            processed += 1

            if processed % 500 == 0:
                job.processed_features = processed
                job.updated_at = time.time()
                _safe_commit(db)

        scan_db.close()

        # Rebuild summary table
        db.query(models.FeatureCombination).delete()
        built_at = time.time()
        rows: List[Dict[str, Any]] = []
        for combo in combos.values():
            # Collect distinct priorities for items in this combo
            combo_priorities = sorted(set(
                priority_by_item[iid]
                for iid in combo["item_ids"]
                if iid in priority_by_item
            ))
            fid = combo["feature_id"]
            legacy_vals = combo["values"]
            legacy_count = len(legacy_vals)

            # D365 mapping lookup (may have multiple D365 attributes per feature)
            d365_entries = d365_by_feature.get(fid, [])
            d365_attr_names = [e["attr"] for e in d365_entries]
            d365_attr = "; ".join(d365_attr_names) if d365_attr_names else None
            # Merge value mappings from all D365 attributes for this feature
            d365_vm_merged: Dict[str, str] = {}
            for entry in d365_entries:
                d365_vm_merged.update(entry["vm"])
            # Build per-value mapping: only include values present in this combo
            d365_vals: Dict[str, str] = {}
            mapped_count = 0
            for lv in legacy_vals:
                mapped_v = d365_vm_merged.get(lv)
                if mapped_v is not None and str(mapped_v).strip():
                    d365_vals[lv] = str(mapped_v).strip()
                    mapped_count += 1
            # Status: complete if all mapped, partial if some, unmapped if none
            if not d365_attr:
                status = "unmapped"
            elif legacy_count == 0:
                # Attribute-only mapping with no values to map — consider complete
                status = "complete"
            elif mapped_count == 0:
                status = "unmapped"
            elif mapped_count >= legacy_count:
                status = "complete"
            else:
                status = "partial"

            rows.append({
                "feature_id": fid,
                "description": combo["description"] or None,
                "unit": combo["unit"] or None,
                "attribute_type": attr_type_by_feature.get(fid) or None,
                "normalized_values_key": _make_values_key(legacy_vals),
                "normalized_values_json": legacy_vals,
                "item_count": len(combo["item_ids"]),
                "legacy_value_count": legacy_count,
                "d365_attribute_id": d365_attr,
                "d365_values_json": d365_vals if d365_vals else None,
                "mapped_value_count": mapped_count,
                "mapping_status": status,
                "priorities_json": combo_priorities if combo_priorities else None,
                "item_ids_json": sorted(combo["item_ids"]),
                "built_at": built_at,
            })
        if rows:
            db.bulk_insert_mappings(models.FeatureCombination, rows)

        job.status = "completed"
        job.processed_features = processed
        job.generated_rows = len(rows)
        job.finished_at = time.time()
        job.updated_at = job.finished_at
        _safe_commit(db)

    except Exception as exc:
        db.rollback()
        logger.exception("feature combination job=%s failed: %s", job_id, exc)
        fail_db = SessionLocal()
        try:
            failed_job = fail_db.query(models.FeatureCombinationJob).filter(models.FeatureCombinationJob.id == job_id).first()
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
        if scan_db is not None:
            scan_db.close()
        db.close()


async def _run_feature_combination_async(job_id: int):
    async with _feature_combination_lock:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, _run_feature_combination_job, job_id)


def _start_feature_combination_job(job_id: int, background_tasks: Optional[BackgroundTasks] = None):
    if background_tasks is not None:
        background_tasks.add_task(_run_feature_combination_async, job_id)
    else:
        loop = asyncio.get_running_loop()
        loop.create_task(_run_feature_combination_async(job_id))


@router.post("/feature-combinations/trigger")
def trigger_feature_combination_build(
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Trigger a background job to rebuild the feature-combination summary table."""
    active = (
        db.query(models.FeatureCombinationJob)
        .filter(models.FeatureCombinationJob.status.in_(["queued", "running"]))
        .order_by(models.FeatureCombinationJob.updated_at.desc())
        .first()
    )
    if active:
        return {"ok": True, "jobId": int(active.id)}

    job = models.FeatureCombinationJob(
        status="queued",
        triggered_by_user_id=f"USR-{current_user.id}",
        triggered_by_username=getattr(current_user, "username", None),
        total_features=0,
        processed_features=0,
        generated_rows=0,
        started_at=None,
        finished_at=None,
        updated_at=time.time(),
        error_message=None,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    _start_feature_combination_job(int(job.id), background_tasks=background_tasks)
    return {"ok": True, "jobId": int(job.id)}


@router.get("/feature-combinations/progress")
def get_feature_combination_progress(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return the latest feature-combination job status."""
    active = (
        db.query(models.FeatureCombinationJob)
        .filter(models.FeatureCombinationJob.status.in_(["queued", "running"]))
        .order_by(models.FeatureCombinationJob.updated_at.desc())
        .first()
    )
    job = active
    is_active = True
    if not job:
        is_active = False
        job = db.query(models.FeatureCombinationJob).order_by(models.FeatureCombinationJob.id.desc()).first()
    if not job:
        return {
            "status": "idle", "isActive": False, "progress": 0.0,
            "totalFeatures": 0, "processedFeatures": 0, "generatedRows": 0,
            "startedAt": None, "finishedAt": None, "error": None,
        }
    total = int(getattr(job, "total_features", 0) or 0)
    processed = int(getattr(job, "processed_features", 0) or 0)
    progress = (processed / total) if total > 0 else (1.0 if job.status == "completed" else 0.0)
    return {
        "id": job.id,
        "status": job.status,
        "isActive": bool(is_active),
        "progress": float(max(0.0, min(1.0, progress))),
        "totalFeatures": total,
        "processedFeatures": processed,
        "generatedRows": int(getattr(job, "generated_rows", 0) or 0),
        "startedAt": getattr(job, "started_at", None),
        "finishedAt": getattr(job, "finished_at", None),
        "error": getattr(job, "error_message", None),
    }


@router.get("/feature-combinations/filters")
def get_feature_combination_filters(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return distinct filter values for dropdowns."""
    feature_ids = [
        r[0] for r in
        db.query(models.FeatureCombination.feature_id)
        .distinct()
        .order_by(models.FeatureCombination.feature_id)
        .all()
    ]
    attribute_types = [
        r[0] for r in
        db.query(models.FeatureCombination.attribute_type)
        .filter(models.FeatureCombination.attribute_type.isnot(None))
        .filter(models.FeatureCombination.attribute_type != "")
        .distinct()
        .order_by(models.FeatureCombination.attribute_type)
        .all()
    ]
    # Collect distinct priorities across all rows' priorities_json
    priority_set: Set[int] = set()
    for (pj,) in db.query(models.FeatureCombination.priorities_json).filter(
        models.FeatureCombination.priorities_json.isnot(None)
    ).all():
        if isinstance(pj, list):
            for p in pj:
                if isinstance(p, int):
                    priority_set.add(p)
    return {
        "featureIds": feature_ids,
        "attributeTypes": attribute_types,
        "priorities": sorted(priority_set),
        "statuses": [
            r[0] for r in
            db.query(models.FeatureCombination.mapping_status)
            .distinct()
            .order_by(models.FeatureCombination.mapping_status)
            .all()
        ],
    }


@router.get("/feature-combinations/list")
def list_feature_combinations(
    search: Optional[str] = None,
    featureId: Optional[str] = None,
    attributeType: Optional[str] = None,
    priority: Optional[int] = None,
    status: Optional[str] = None,
    sortBy: Optional[str] = None,
    sortDir: Optional[str] = None,
    limit: int = Query(50, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Paginated list of generated feature-combination summary rows."""
    base = db.query(models.FeatureCombination)
    if search:
        if len(search) > MAX_SEARCH_LENGTH:
            raise HTTPException(status_code=400, detail="search too long")
        like = f"%{search}%"
        base = base.filter(
            or_(
                models.FeatureCombination.feature_id.ilike(like),
                models.FeatureCombination.description.ilike(like),
                models.FeatureCombination.normalized_values_key.ilike(like),
            )
        )
    # Multi-value filters: comma-separated strings
    if featureId:
        fids = [f.strip() for f in featureId.split(",") if f.strip()]
        if len(fids) == 1:
            base = base.filter(models.FeatureCombination.feature_id == fids[0])
        elif fids:
            base = base.filter(models.FeatureCombination.feature_id.in_(fids))
    if attributeType:
        ats = [a.strip() for a in attributeType.split(",") if a.strip()]
        if len(ats) == 1:
            base = base.filter(models.FeatureCombination.attribute_type == ats[0])
        elif ats:
            base = base.filter(models.FeatureCombination.attribute_type.in_(ats))
    if status:
        sts = [s.strip() for s in status.split(",") if s.strip()]
        if len(sts) == 1:
            base = base.filter(models.FeatureCombination.mapping_status == sts[0])
        elif sts:
            base = base.filter(models.FeatureCombination.mapping_status.in_(sts))
    # For priority filter: use JSON contains via string match (SQLite doesn't have native JSON contains)
    if priority is not None:
        base = base.filter(
            models.FeatureCombination.priorities_json.isnot(None),
            cast(models.FeatureCombination.priorities_json, String).contains(str(priority)),
        )
    total = base.count()

    # Sorting
    sort_allowed = {
        "itemCount": models.FeatureCombination.item_count,
        "legacyValueCount": models.FeatureCombination.legacy_value_count,
        "mappedValueCount": models.FeatureCombination.mapped_value_count,
    }
    sort_col = sort_allowed.get(sortBy) if sortBy else None
    is_desc = (sortDir or "desc").lower() != "asc"

    if sortBy == "comboCountForFeature":
        # Sort by the number of combo rows sharing the same feature_id
        from sqlalchemy import select
        combo_count_sub = (
            select(
                models.FeatureCombination.feature_id,
                func.count(models.FeatureCombination.id).label("cnt"),
            )
            .group_by(models.FeatureCombination.feature_id)
            .subquery()
        )
        base = base.outerjoin(
            combo_count_sub,
            models.FeatureCombination.feature_id == combo_count_sub.c.feature_id,
        )
        order_expr = combo_count_sub.c.cnt.desc() if is_desc else combo_count_sub.c.cnt.asc()
        rows = base.order_by(order_expr, models.FeatureCombination.feature_id).offset(offset).limit(limit).all()
    elif sort_col is not None:
        order = sort_col.desc() if is_desc else sort_col.asc()
        rows = base.order_by(order, models.FeatureCombination.feature_id).offset(offset).limit(limit).all()
    else:
        rows = (
            base
            .order_by(models.FeatureCombination.item_count.desc(), models.FeatureCombination.feature_id)
            .offset(offset)
            .limit(limit)
            .all()
        )

    # Pre-compute combo count per feature_id (how many combo rows share this feature_id)
    feature_ids_in_page = list({r.feature_id for r in rows})
    combo_count_map: Dict[str, int] = {}
    if feature_ids_in_page:
        counts = (
            db.query(models.FeatureCombination.feature_id, func.count(models.FeatureCombination.id))
            .filter(models.FeatureCombination.feature_id.in_(feature_ids_in_page))
            .group_by(models.FeatureCombination.feature_id)
            .all()
        )
        combo_count_map = {fid: cnt for fid, cnt in counts}

    # When a priority filter is active, compute filtered item counts per combo
    filtered_item_counts: Dict[int, int] = {}
    if priority is not None and rows:
        # Get all item_ids that belong to the selected priority
        priority_item_ids: Set[str] = set(
            iid for (iid,) in
            db.query(models.BomItem.item_id).filter(models.BomItem.priority == priority).all()
        )
        for r in rows:
            stored_ids = r.item_ids_json or []
            filtered_item_counts[r.id] = len(set(stored_ids) & priority_item_ids)

    items = [
        {
            "id": r.id,
            "featureId": r.feature_id,
            "description": r.description or "",
            "unit": r.unit or "",
            "attributeType": r.attribute_type or "",
            "normalizedValues": r.normalized_values_json or [],
            "normalizedValuesKey": r.normalized_values_key,
            "itemCount": r.item_count,
            "filteredItemCount": filtered_item_counts.get(r.id) if priority is not None else None,
            "legacyValueCount": r.legacy_value_count if hasattr(r, "legacy_value_count") else len(r.normalized_values_json or []),
            "comboCountForFeature": combo_count_map.get(r.feature_id, 1),
            "d365AttributeId": r.d365_attribute_id or "",
            "d365Values": r.d365_values_json or {},
            "mappedValueCount": r.mapped_value_count if hasattr(r, "mapped_value_count") else 0,
            "mappingStatus": r.mapping_status if hasattr(r, "mapping_status") else "unmapped",
            "priorities": r.priorities_json or [],
            "builtAt": r.built_at,
        }
        for r in rows
    ]
    return {"items": items, "total": total}


@router.get("/feature-combinations/{combo_id}/items")
def get_feature_combination_items(
    combo_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return the BOM items whose features match the selected combination."""
    combo = db.query(models.FeatureCombination).filter(models.FeatureCombination.id == combo_id).first()
    if not combo:
        raise HTTPException(status_code=404, detail="combination not found")

    target_feature_id = combo.feature_id
    target_key = combo.normalized_values_key

    # Scan BomFeature rows for this feature_id, then filter by normalized key
    features = (
        db.query(models.BomFeature)
        .filter(models.BomFeature.feature_id == target_feature_id)
        .all()
    )
    matching_item_pks: Set[int] = set()
    for feat in features:
        normalized = _normalize_feature_values(getattr(feat, "values", []))
        if _make_values_key(normalized) == target_key:
            matching_item_pks.add(feat.item_id)

    if not matching_item_pks:
        return {"items": []}

    bom_items = (
        db.query(models.BomItem)
        .filter(models.BomItem.id.in_(matching_item_pks))
        .order_by(models.BomItem.item_id)
        .all()
    )
    return {
        "items": [
            {
                "itemId": itm.item_id,
                "description": itm.description or "",
                "category": itm.category or "",
                "productType": itm.product_type or "",
                "priority": itm.priority,
                "classification": itm.classification or "",
            }
            for itm in bom_items
        ]
    }


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

    # Build a lookup: legacy_feature_id → list of all global mapping target attributes
    # so we can show all targets when a feature maps to multiple attributes.
    feature_ids_in_item = list({row.legacy_feature_id for row in rows})
    all_global_targets: Dict[str, List[str]] = {}
    if feature_ids_in_item:
        all_gms = db.query(models.GlobalMapping).all()
        for gm in all_gms:
            gm_feature_ids = gm.legacy_feature_ids or []
            target = (gm.new_attribute_id or "").strip()
            if not target:
                continue
            for fid in gm_feature_ids:
                fid_str = str(fid).strip()
                if fid_str in feature_ids_in_item:
                    if fid_str not in all_global_targets:
                        all_global_targets[fid_str] = []
                    if target not in all_global_targets[fid_str]:
                        all_global_targets[fid_str].append(target)

    result = []
    for row in rows:
        source = (row.mapped_from or "").strip() or "global"
        # Local override → use the workspace mapping's own target, ignore global
        if source != "global":
            targets = [row.new_attribute_id] if (row.new_attribute_id or "").strip() else []
        else:
            targets = all_global_targets.get(row.legacy_feature_id, [])
        result.append({
            "itemId": row.legacy_item_id,
            "legacyFeatureId": row.legacy_feature_id,
            "legacyValue": row.legacy_value,
            "newAttributeId": row.new_attribute_id,
            "newValue": row.new_value,
            "attributeType": (row.attribute_type or "").strip(),
            "condition": (row.condition or "").strip() or None,
            "formula": (row.formula or "").strip() or None,
            "mappedFrom": source,
            "signedOnByUserId": row.signed_on_by_user_id,
            "signedOnByUsername": row.signed_on_by_username,
            "signedOnAt": row.signed_on_at,
            "updatedAt": row.updated_at,
            "allGlobalTargets": targets,
        })
    return result


def _regenerate_item_from_global(item_id: str, user_id: str, username: str, db: Session):
    """Delete ALL workspace_mapping rows for an item and regenerate from global mappings."""
    deleted = (
        db.query(models.WorkspaceMapping)
        .filter(models.WorkspaceMapping.legacy_item_id == item_id)
        .delete(synchronize_session=False)
    )
    db.commit()

    # Look up the BomItem PK for this item_id
    bom_item = db.query(models.BomItem).filter(models.BomItem.item_id == item_id).first()
    if not bom_item:
        return {"ok": True, "rowsDeleted": deleted, "rowsGenerated": 0}

    mapping_by_feature = _build_latest_mapping_by_feature(db.query(models.GlobalMapping).all())
    features = db.query(models.BomFeature).filter(models.BomFeature.item_id == bom_item.id).all()

    signed_ts = time.time()
    generated = 0
    for feat in features:
        feat_feature_id = str(getattr(feat, "feature_id", "") or "").strip()
        mapping = mapping_by_feature.get(feat_feature_id)
        target_attr = (getattr(mapping, "new_attribute_id", "") or "").strip() or "UNMAPPED"
        attr_type = (getattr(mapping, "attribute_type", "") or "").strip() if mapping else ""
        feat_condition = (getattr(feat, "condition", "") or "").strip() or None
        feat_formula = (getattr(feat, "formula", "") or "").strip() or None
        value_mappings = getattr(mapping, "value_mappings", {}) if mapping else {}

        raw_values = getattr(feat, "values", []) or []
        if isinstance(raw_values, dict):
            values = [str(v) for v in (raw_values.get("values") or [])]
        elif isinstance(raw_values, list):
            values = [str(v) for v in raw_values]
        else:
            values = []

        if not values:
            db.add(models.WorkspaceMapping(
                legacy_item_id=item_id,
                legacy_feature_id=feat_feature_id,
                legacy_value="",
                new_attribute_id=target_attr,
                new_value="",
                attribute_type=attr_type,
                condition=feat_condition,
                formula=feat_formula,
                mapped_from="global",
                signed_on_by_user_id=user_id,
                signed_on_by_username=username,
                signed_on_at=signed_ts,
                updated_at=time.time(),
                version=1,
                created_by=user_id,
                modified_by=user_id,
                modified_at=time.time(),
            ))
            generated += 1
        else:
            for legacy_value in values:
                resolved = _resolve_value_mapping(value_mappings, legacy_value)
                db.add(models.WorkspaceMapping(
                    legacy_item_id=item_id,
                    legacy_feature_id=feat_feature_id,
                    legacy_value=str(legacy_value),
                    new_attribute_id=target_attr,
                    new_value=(resolved or ""),
                    attribute_type=attr_type,
                    condition=feat_condition,
                    formula=feat_formula,
                    mapped_from="global" if resolved else "",
                    signed_on_by_user_id=user_id,
                    signed_on_by_username=username,
                    signed_on_at=signed_ts,
                    updated_at=time.time(),
                    version=1,
                    created_by=user_id,
                    modified_by=user_id,
                    modified_at=time.time(),
                ))
                generated += 1

    db.commit()
    return {"ok": True, "rowsDeleted": deleted, "rowsGenerated": generated}


@router.post("/workspace-mappings/{item_id}/revert-to-global")
def revert_item_to_global(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Delete all workspace_mapping rows for an item and regenerate from global mappings."""
    current_user_id = f"USR-{current_user.id}"
    if getattr(current_user, "role", "user") != "admin":
        lock_row = db.query(models.ItemLock).filter(models.ItemLock.item_id == item_id).first()
        if not lock_row or lock_row.user_id != current_user_id:
            raise HTTPException(status_code=403, detail="item must be signed on by current user")

    return _regenerate_item_from_global(item_id, current_user_id, getattr(current_user, "username", None), db)


@router.post("/workspace-mappings/revert-all-to-global")
def revert_all_to_global(
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Delete ALL local overrides and trigger full regeneration from global mappings."""
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="admin only")

    # Delete all local override rows so regeneration replaces them
    deleted = (
        db.query(models.WorkspaceMapping)
        .filter(models.WorkspaceMapping.mapped_from == "local")
        .delete(synchronize_session=False)
    )
    db.commit()

    # Trigger full regeneration (reuses existing job infrastructure)
    _cleanup_stale_generation_jobs(db)
    active_job = (
        db.query(models.MappingGenerationJob)
        .filter(models.MappingGenerationJob.status.in_(["queued", "running"]))
        .first()
    )
    if active_job:
        return {"ok": True, "localRowsDeleted": deleted, "mappingGenerationJobId": int(active_job.id)}

    queued_job = models.MappingGenerationJob(
        status="queued",
        triggered_by_user_id=f"USR-{current_user.id}",
        triggered_by_username=getattr(current_user, "username", None),
        trigger_source="revert_all_to_global",
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
    return {"ok": True, "localRowsDeleted": deleted, "mappingGenerationJobId": job_id}


@router.put("/workspace-mappings/{item_id}")
def put_workspace_mappings_for_item(
    item_id: str,
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    current_user_id = f"USR-{current_user.id}"
    if getattr(current_user, "role", "user") != "admin":
        lock_row = db.query(models.ItemLock).filter(models.ItemLock.item_id == item_id).first()
        if not lock_row or lock_row.user_id != current_user_id:
            raise HTTPException(status_code=403, detail="item must be signed on by current user")

    rows_payload = payload.get("rows") or []
    if not isinstance(rows_payload, list):
        raise HTTPException(status_code=400, detail="rows must be an array")

    rows_upserted = 0
    signed_ts = time.time()
    for row in rows_payload:
        if not isinstance(row, dict):
            continue
        legacy_feature_id = str(row.get("legacyFeatureId") or row.get("legacy_feature_id") or "").strip()
        if not legacy_feature_id:
            continue

        legacy_value = str(row.get("legacyValue") or row.get("legacy_value") or "")
        new_attribute_id = str(row.get("newAttributeId") or row.get("new_attribute_id") or "UNMAPPED")
        new_value = str(row.get("newValue") or row.get("new_value") or "")
        attribute_type = str(row.get("attributeType") or row.get("attribute_type") or "")
        condition = str(row.get("condition") or "") or None
        formula = str(row.get("formula") or "") or None
        mapped_from = str(row.get("mappedFrom") or row.get("mapped_from") or "global")

        existing = (
            db.query(models.WorkspaceMapping)
            .filter(
                models.WorkspaceMapping.legacy_item_id == item_id,
                models.WorkspaceMapping.legacy_feature_id == legacy_feature_id,
                models.WorkspaceMapping.legacy_value == legacy_value,
            )
            .first()
        )
        if existing:
            existing.new_attribute_id = new_attribute_id
            existing.new_value = new_value
            existing.attribute_type = attribute_type
            existing.condition = condition
            existing.formula = formula
            existing.mapped_from = mapped_from
            existing.signed_on_by_user_id = current_user_id
            existing.signed_on_by_username = getattr(current_user, "username", None)
            existing.signed_on_at = signed_ts
            existing.updated_at = time.time()
            existing.modified_by = current_user_id
            existing.modified_at = time.time()
            existing.version = (existing.version or 0) + 1
        else:
            db.add(models.WorkspaceMapping(
                legacy_item_id=item_id,
                legacy_feature_id=legacy_feature_id,
                legacy_value=legacy_value,
                new_attribute_id=new_attribute_id,
                new_value=new_value,
                attribute_type=attribute_type,
                condition=condition,
                formula=formula,
                mapped_from=mapped_from,
                signed_on_by_user_id=current_user_id,
                signed_on_by_username=getattr(current_user, "username", None),
                signed_on_at=signed_ts,
                updated_at=time.time(),
                version=1,
                created_by=current_user_id,
                modified_by=current_user_id,
                modified_at=time.time(),
            ))
        rows_upserted += 1

    db.commit()
    return {"ok": True, "rowsSaved": rows_upserted}

@router.get("/state")
def get_state(
    include_bom: bool = Query(True),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    state: Dict[str, Any] = {
        "bom": [],
        "mappings": [],
        "classifications": [],
        "localMappings": {},
        "itemClassifications": {},
        "locks": {},
        "users": [],
    }

    # Classifications from dedicated table
    db_classes = db.query(models.Classification).all()
    state["classifications"] = [
        {"classId": c.class_id, "className": c.class_name, "attributes": c.attributes or []}
        for c in db_classes
    ]

    # Users from dedicated table
    db_users = db.query(models.User).all()
    state["users"] = [
        {
            "userId": f"USR-{u.id}",
            "userName": u.username,
            "password": "",
            "role": u.role or "user",
            "approvalStatus": getattr(u, "approval_status", "approved"),
        }
        for u in db_users
    ]

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
    state["locks"] = locks_dict

    # Item classifications from bom_items table
    classified = db.query(models.BomItem.item_id, models.BomItem.classification).filter(
        models.BomItem.classification.isnot(None),
        models.BomItem.classification != "",
    ).all()
    state["itemClassifications"] = {row.item_id: row.classification for row in classified}

    # Config from app_config table
    state["mappingTypeConfig"] = _get_mapping_type_config(db)

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
                "id": getattr(m, "id", None),
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


def _apply_bom_priority_filter(query, priority: Optional[int]):
    """Apply priority filter when a specific priority value is provided."""
    if priority is None:
        return query
    return query.filter(models.BomItem.priority == priority)


def _get_unmapped_item_ids(db: Session) -> Set[str]:
    """Return the set of BOM item_ids whose mapping status is 'unmapped'.

    Uses the workspace_mappings table with SQL aggregation for correctness
    and performance.
    """
    included_type_set = _get_included_type_set(db)

    all_item_ids = {row[0] for row in db.query(models.BomItem.item_id).all()}
    item_stats: Dict[str, Dict[str, int]] = {item_id: {"mapped": 0, "not_required": 0, "total": 0} for item_id in all_item_ids}

    from sqlalchemy import func, case, literal_column
    WM = models.WorkspaceMapping
    has_empty_val = func.sum(
        case(
            (func.trim(func.coalesce(WM.new_value, literal_column("''"))) == literal_column("''"), 1),
            else_=0,
        )
    ).label("empty_count")

    feature_q = (
        db.query(
            WM.legacy_item_id,
            WM.legacy_feature_id,
            func.max(WM.new_attribute_id).label("new_attribute_id"),
            func.max(WM.attribute_type).label("attribute_type"),
            has_empty_val,
        )
        .group_by(WM.legacy_item_id, WM.legacy_feature_id)
        .all()
    )

    for row in feature_q:
        item_id = row.legacy_item_id
        stats = item_stats.get(item_id)
        if stats is None:
            continue
        attr_type = (row.attribute_type or "").strip().lower()
        if included_type_set and attr_type and attr_type not in included_type_set:
            continue
        target = (row.new_attribute_id or "").strip().upper()
        stats["total"] += 1
        if target == "NOT REQUIRED":
            stats["not_required"] += 1
        elif target and target != "UNMAPPED":
            if row.empty_count == 0:
                stats["mapped"] += 1

    unmapped: Set[str] = set()
    for item_id, s in item_stats.items():
        total = s["total"]
        mapped = s["mapped"]
        not_required = s["not_required"]
        if total == 0:
            continue  # notRequired — not unmapped
        elif mapped + not_required >= total and mapped > 0:
            continue  # mapped
        elif mapped == 0 and not_required >= total:
            continue  # notRequired
        else:
            unmapped.add(item_id)
    return unmapped


def _apply_unmapped_only_filter(query, unmapped_only: bool, db: Session):
    """When unmapped_only is True, restrict query to unmapped BOM items."""
    if not unmapped_only:
        return query
    unmapped_ids = _get_unmapped_item_ids(db)
    if not unmapped_ids:
        return query.filter(models.BomItem.item_id == None)  # noqa: E711 — no results
    return query.filter(models.BomItem.item_id.in_(unmapped_ids))


@router.get("/bom/filters")
def get_bom_filters(
    category: Optional[str] = None,
    productType: Optional[str] = None,
    productLine: Optional[str] = Query(None, alias="productLine"),
    priority: Optional[int] = None,
    db: Session = Depends(get_db),
):
    selected_product_type = productType or productLine

    # For categories: filter by selected product type and priority only.
    cat_query = db.query(models.BomItem)
    cat_query = _apply_bom_product_type_filter(cat_query, selected_product_type)
    cat_query = _apply_bom_priority_filter(cat_query, priority)
    categories = cat_query.with_entities(models.BomItem.category).distinct().all()

    # For product types: filter by selected category and priority only.
    pt_query = db.query(models.BomItem)
    pt_query = _apply_bom_category_filter(pt_query, category)
    pt_query = _apply_bom_priority_filter(pt_query, priority)
    product_types = pt_query.with_entities(models.BomItem.product_type).distinct().all()

    # For priorities: filter by selected category and product type only.
    priority_query = db.query(models.BomItem)
    priority_query = _apply_bom_category_filter(priority_query, category)
    priority_query = _apply_bom_product_type_filter(priority_query, selected_product_type)

    category_list = sorted({c[0] for c in categories if c and c[0]})
    product_type_list = sorted({p[0] for p in product_types if p and p[0]})

    # Include (blank) sentinel when items with NULL/empty values exist
    has_blank_category = any((c[0] is None or c[0] == "") for c in categories)
    has_blank_product_type = any((p[0] is None or p[0] == "") for p in product_types)
    if has_blank_category:
        category_list.insert(0, BLANK_SENTINEL)
    if has_blank_product_type:
        product_type_list.insert(0, BLANK_SENTINEL)

    # Collect distinct non-null priority values
    priority_rows = priority_query.with_entities(models.BomItem.priority).filter(models.BomItem.priority != None).distinct().all()  # noqa: E711
    priorities = sorted({int(p[0]) for p in priority_rows if p[0] is not None})

    return {"categories": category_list, "productTypes": product_type_list, "priorities": priorities}


@router.get("/bom/count")
def get_bom_count(
    category: Optional[str] = None,
    productType: Optional[str] = None,
    search: Optional[str] = None,
    priority: Optional[int] = None,
    unmappedOnly: bool = False,
    db: Session = Depends(get_db),
):
    """Return only the total count of BOM items matching the filter — no feature data."""
    search = _validate_search(search)
    query = db.query(func.count(models.BomItem.id))
    query = _apply_bom_category_filter(query, category)
    query = _apply_bom_product_type_filter(query, productType)
    query = _apply_bom_priority_filter(query, priority)
    query = _apply_unmapped_only_filter(query, unmappedOnly, db)
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
            "approvalStatus": getattr(u, "approval_status", "approved"),
        }
        for u in db_users
    ]

    # Config from app_config table
    mapping_type_config = _get_mapping_type_config(db)

    # Item classifications from bom_items table
    classified = db.query(models.BomItem.item_id, models.BomItem.classification).filter(
        models.BomItem.classification.isnot(None),
        models.BomItem.classification != "",
    ).all()
    item_classifications = {row.item_id: row.classification for row in classified}

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
    search: Optional[str] = None,
    priority: Optional[int] = None,
    unmappedOnly: bool = False,
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return BOM items the user has signed on to, with fallback to unlocked items."""
    search = _validate_search(search)
    is_admin = getattr(current_user, "role", "user") == "admin"
    current_user_id = f"USR-{current_user.id}"

    # ------------------------------------------------------------------
    # Admin with no userId filter → browse ALL BOM items with full count
    # ------------------------------------------------------------------
    if is_admin and not userId:
        query = db.query(models.BomItem).options(selectinload(models.BomItem.features))
        query = _apply_bom_category_filter(query, category)
        query = _apply_bom_product_type_filter(query, productType)
        query = _apply_bom_priority_filter(query, priority)
        query = _apply_unmapped_only_filter(query, unmappedOnly, db)
        if search:
            like = f"%{search}%"
            query = query.filter(
                or_(
                    models.BomItem.item_id.ilike(like),
                    models.BomItem.description.ilike(like),
                )
            )
        total_count = query.count()
        signed_on_count = db.query(func.count(models.ItemLock.item_id)).scalar() or 0
        query = query.order_by(models.BomItem.item_id).offset(offset).limit(limit)
        bom_items = query.all()
        return {
            "items": _build_bom_payload(bom_items),
            "signedOnCount": signed_on_count,
            "totalCount": total_count,
        }

    # ------------------------------------------------------------------
    # Non-admin (or admin with specific userId) — signed-on items first
    # ------------------------------------------------------------------
    target_user_id = userId if (is_admin and userId) else current_user_id

    # Get locked item_ids for target user
    lock_query = db.query(models.ItemLock.item_id).filter(
        models.ItemLock.user_id == target_user_id
    )
    locked_item_ids = [row[0] for row in lock_query.all()]
    signed_on_count = 0
    total_count = 0
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
        query = _apply_bom_priority_filter(query, priority)
        if search:
            like = f"%{search}%"
            query = query.filter(
                or_(
                    models.BomItem.item_id.ilike(like),
                    models.BomItem.description.ilike(like),
                )
            )
        signed_on_count = query.count()
        if signed_on_count > 0:
            total_count = signed_on_count
            query = query.order_by(models.BomItem.item_id).offset(offset).limit(limit)
            bom_items = query.all()

    # Fallback: if no signed-on items (after filter), load unlocked items
    if signed_on_count == 0:
        all_locked_ids = [row[0] for row in db.query(models.ItemLock.item_id).all()]
        fallback_query = db.query(models.BomItem).options(selectinload(models.BomItem.features))
        if all_locked_ids:
            fallback_query = fallback_query.filter(~models.BomItem.item_id.in_(all_locked_ids))
        fallback_query = _apply_bom_category_filter(fallback_query, category)
        fallback_query = _apply_bom_product_type_filter(fallback_query, productType)
        fallback_query = _apply_bom_priority_filter(fallback_query, priority)
        if search:
            like = f"%{search}%"
            fallback_query = fallback_query.filter(
                or_(
                    models.BomItem.item_id.ilike(like),
                    models.BomItem.description.ilike(like),
                )
            )
        total_count = fallback_query.count()
        fallback_query = fallback_query.order_by(models.BomItem.item_id).offset(offset).limit(limit)
        bom_items = fallback_query.all()

    return {
        "items": _build_bom_payload(bom_items),
        "signedOnCount": signed_on_count,
        "totalCount": total_count,
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
                    **({"condition": getattr(feat, "condition", None)} if getattr(feat, "condition", None) else {}),
                    **({"formula": getattr(feat, "formula", None)} if getattr(feat, "formula", None) else {}),
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
                **({"priority": getattr(itm, "priority", None)} if getattr(itm, "priority", None) is not None else {}),
                **({"classification": getattr(itm, "classification", None)} if getattr(itm, "classification", None) else {}),
                **({"mlPredictions": getattr(itm, "ml_predictions", None)} if getattr(itm, "ml_predictions", None) else {}),
                "features": features_payload,
            }
        )

    return bom_payload


@router.get("/bom/items")
def get_bom_items(
    category: Optional[str] = None,
    productType: Optional[str] = None,
    search: Optional[str] = None,
    priority: Optional[int] = None,
    unmappedOnly: bool = False,
    limit: int = Query(20, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    search = _validate_search(search)
    query = db.query(models.BomItem).options(selectinload(models.BomItem.features))
    query = _apply_bom_category_filter(query, category)
    query = _apply_bom_product_type_filter(query, productType)
    query = _apply_bom_priority_filter(query, priority)
    query = _apply_unmapped_only_filter(query, unmappedOnly, db)
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
    incoming.pop("itemClassifications", None)
    incoming.pop("classAttributeValues", None)
    mapping_sync_mode = str(incoming.pop("mappingSyncMode", "merge") or "merge").strip().lower()
    apply_global_deletes = bool(incoming.pop("applyGlobalDeletes", False))

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
    # Accept all mappings from the client as-is.  Placeholder pruning used to
    # silently strip empty-target entries that the user deliberately imported
    # from a CSV, so we no longer prune here.
    mappings_key_present = "mappings" in incoming
    mappings_payload = incoming.pop("mappings", None) or []
    logger.info("sync_state received mappings=%s (key_present=%s)", len(mappings_payload), mappings_key_present)
    deleted_global_mapping_ids_payload = incoming.pop("deletedGlobalMappingIds", None) or []
    deleted_global_mapping_keys_payload = incoming.pop("deletedGlobalMappingKeys", None) or []
    local_mappings_key_present = "localMappings" in incoming
    local_mappings_payload = incoming.pop("localMappings", None) or {}
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
                    "priority": item.get("priority") or None,
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
                            "condition": feat.get("condition") or None,
                            "formula": feat.get("formula") or None,
                            "values": composite_values,
                        }
                    )

            if bom_feature_rows:
                db.bulk_insert_mappings(models.BomFeature, bom_feature_rows)

    current_user_id = f"USR-{current_user.id}"
    now_ts = time.time()

    global_mappings_inserted = 0
    global_mappings_updated = 0
    global_mappings_deleted = 0

    deleted_global_mapping_ids: List[int] = []
    for raw_id in deleted_global_mapping_ids_payload:
        try:
            parsed = int(raw_id)
        except (TypeError, ValueError):
            continue
        if parsed > 0:
            deleted_global_mapping_ids.append(parsed)

    deleted_global_mapping_keys = {
        str(raw_key or "").strip()
        for raw_key in deleted_global_mapping_keys_payload
        if str(raw_key or "").strip()
    }
    if not apply_global_deletes:
        if deleted_global_mapping_ids or deleted_global_mapping_keys:
            logger.warning(
                "sync_state: ignoring global mapping deletes (mode=%s, ids=%s, keys=%s)",
                mapping_sync_mode,
                len(deleted_global_mapping_ids),
                len(deleted_global_mapping_keys),
            )
        deleted_global_mapping_ids = []
        deleted_global_mapping_keys = set()
    global_mappings_collapsed = 0

    if not mappings_key_present and not deleted_global_mapping_ids and not deleted_global_mapping_keys:
        logger.info("sync_state: mappings key not present, skipping global mappings upsert")
    else:
        # Apply explicit deletes first so removed rows are not revived by stale caches.
        if deleted_global_mapping_ids:
            global_mappings_deleted += int(
                db.query(models.GlobalMapping)
                .filter(models.GlobalMapping.id.in_(deleted_global_mapping_ids))
                .delete(synchronize_session=False)
                or 0
            )

        if deleted_global_mapping_keys:
            rows_for_key_delete = db.query(models.GlobalMapping).all()
            ids_to_delete_by_key: List[int] = []
            for row in rows_for_key_delete:
                natural_key = _global_mapping_natural_key(
                    _normalize_legacy_feature_ids(getattr(row, "legacy_feature_ids", []) or []),
                    str(getattr(row, "new_attribute_id", "") or "").strip(),
                )
                if natural_key in deleted_global_mapping_keys and getattr(row, "id", None) is not None:
                    ids_to_delete_by_key.append(int(row.id))
            if ids_to_delete_by_key:
                global_mappings_deleted += int(
                    db.query(models.GlobalMapping)
                    .filter(models.GlobalMapping.id.in_(ids_to_delete_by_key))
                    .delete(synchronize_session=False)
                    or 0
                )
        if mappings_key_present:
            normalized_payload: List[Dict[str, Any]] = []
            for sequence, m in enumerate(mappings_payload):
                if not isinstance(m, dict):
                    continue
                mapping_id: Optional[int] = None
                raw_id = m.get("id")
                if raw_id is not None:
                    try:
                        parsed_id = int(raw_id)
                        if parsed_id > 0:
                            mapping_id = parsed_id
                    except (TypeError, ValueError):
                        mapping_id = None

                normalized_payload.append(
                    {
                        "id": mapping_id,
                        "legacy_feature_ids": _normalize_legacy_feature_ids(m.get("legacyFeatureIds") or []),
                        "new_attribute_id": str(m.get("newAttributeId") or "").strip(),
                        "attribute_type": str(m.get("attributeType") or "").strip().lower(),
                        "value_mappings": _normalize_value_mappings(m.get("valueMappings") or {}),
                        "version": int(m.get("version") or 1),
                        "created_by": m.get("createdBy") or current_user_id,
                        "modified_at": m.get("modifiedAt"),
                        "client_edited_at": m.get("_clientEditedAt"),
                        "_sequence": sequence,
                    }
                )

            normalized_payload, global_mappings_collapsed = _dedupe_global_mapping_payload(normalized_payload)

            all_existing_rows = db.query(models.GlobalMapping).all()
            existing_by_id: Dict[int, models.GlobalMapping] = {
                int(existing_row.id): existing_row
                for existing_row in all_existing_rows
                if getattr(existing_row, "id", None) is not None
            }
            existing_groups: Dict[str, List[models.GlobalMapping]] = {}
            for existing_row in all_existing_rows:
                existing_key = _global_mapping_natural_key(
                    _normalize_legacy_feature_ids(getattr(existing_row, "legacy_feature_ids", []) or []),
                    str(getattr(existing_row, "new_attribute_id", "") or "").strip(),
                )
                existing_groups.setdefault(existing_key, []).append(existing_row)

            keep_row_id_by_key: Dict[str, int] = {}
            processed_natural_keys: set[str] = set()

            for row in normalized_payload:
                existing_row: Optional[models.GlobalMapping] = None
                natural_key = _global_mapping_natural_key(row["legacy_feature_ids"], row["new_attribute_id"])
                processed_natural_keys.add(natural_key)
                payload_id = row.get("id")
                if payload_id is not None:
                    existing_row = existing_by_id.get(int(payload_id))
                if existing_row is None:
                    # Always fall back to natural-key lookup regardless of sync
                    # mode to prevent duplicate global mapping rows.
                    matching_group = existing_groups.get(natural_key) or []
                    if matching_group:
                        existing_row = max(matching_group, key=_global_mapping_model_rank)

                if existing_row is None:
                    db.add(
                        models.GlobalMapping(
                            legacy_feature_ids=row["legacy_feature_ids"],
                            new_attribute_id=row["new_attribute_id"],
                            attribute_type=row["attribute_type"],
                            value_mappings=row["value_mappings"],
                            version=max(int(row.get("version") or 1), 1),
                            created_by=row.get("created_by") or current_user_id,
                            modified_by=current_user_id,
                            modified_at=now_ts,
                        )
                    )
                    global_mappings_inserted += 1
                    continue

                keep_row_id_by_key[natural_key] = int(existing_row.id)

                if _global_mapping_row_changed(
                    existing_row,
                    row["legacy_feature_ids"],
                    row["new_attribute_id"],
                    row["attribute_type"],
                    row["value_mappings"],
                ):
                    existing_version = int(getattr(existing_row, "version", 1) or 1)
                    existing_row.legacy_feature_ids = row["legacy_feature_ids"]
                    existing_row.new_attribute_id = row["new_attribute_id"]
                    existing_row.attribute_type = row["attribute_type"]
                    existing_row.value_mappings = row["value_mappings"]
                    existing_row.version = max(existing_version + 1, int(row.get("version") or existing_version))
                    existing_row.modified_by = current_user_id
                    existing_row.modified_at = now_ts
                    global_mappings_updated += 1

            if apply_global_deletes:
                duplicate_ids_to_delete: List[int] = []
                for natural_key in processed_natural_keys:
                    keep_id = keep_row_id_by_key.get(natural_key)
                    if keep_id is None:
                        continue
                    for existing_row in existing_groups.get(natural_key, []):
                        row_id = getattr(existing_row, "id", None)
                        if row_id is not None and int(row_id) != keep_id:
                            duplicate_ids_to_delete.append(int(row_id))
                if duplicate_ids_to_delete:
                    global_mappings_deleted += int(
                        db.query(models.GlobalMapping)
                        .filter(models.GlobalMapping.id.in_(duplicate_ids_to_delete))
                        .delete(synchronize_session=False)
                        or 0
                    )

    # Upsert workspace mappings for ONLY the items sent in localMappings.
    # Never delete all workspace mappings — only update/insert specific rows.
    workspace_rows_upserted = 0
    if not local_mappings_key_present:
        logger.info("sync_state: localMappings key not present, skipping workspace mappings upsert")
    else:
        signed_ts = time.time()
        for item_id, mappings_for_item in (local_mappings_payload or {}).items():
            if not item_id:
                continue

            for m in mappings_for_item or []:
                legacy_ids = m.get("legacyFeatureIds") or []
                new_attr = m.get("newAttributeId") or ""
                values_map = m.get("valueMappings") or {}
                attr_type = str(m.get("attributeType") or "").strip().lower()
                mapped_from = str(m.get("mappedFrom") or "local")

                for legacy_attr in legacy_ids:
                    if not values_map:
                        # No value mappings from frontend — auto-populate from
                        # global mapping for this specific feature.
                        gm_row = (
                            db.query(models.GlobalMapping)
                            .filter(models.GlobalMapping.legacy_feature_ids.contains([legacy_attr]))
                            .first()
                        )
                        if not gm_row:
                            # Fallback: scan all global mappings for this feature
                            for _gm in db.query(models.GlobalMapping).all():
                                if legacy_attr in (getattr(_gm, "legacy_feature_ids", []) or []):
                                    gm_row = _gm
                                    break
                        global_vals = (getattr(gm_row, "value_mappings", {}) or {}) if gm_row else {}

                        existing_rows = (
                            db.query(models.WorkspaceMapping)
                            .filter(
                                models.WorkspaceMapping.legacy_item_id == item_id,
                                models.WorkspaceMapping.legacy_feature_id == legacy_attr,
                            )
                            .all()
                        )
                        if existing_rows:
                            for existing in existing_rows:
                                existing.new_attribute_id = new_attr
                                existing.attribute_type = attr_type
                                existing.mapped_from = mapped_from
                                # Auto-populate new_value from global mapping
                                if global_vals and existing.legacy_value:
                                    gval = global_vals.get(existing.legacy_value, "")
                                    existing.new_value = str(gval)
                                existing.signed_on_by_user_id = current_user_id
                                existing.signed_on_by_username = getattr(current_user, "username", None)
                                existing.signed_on_at = signed_ts
                                existing.updated_at = now_ts
                                existing.modified_by = current_user_id
                                existing.modified_at = now_ts
                                existing.version = (existing.version or 0) + 1
                                workspace_rows_upserted += 1
                        else:
                            # No existing rows at all — insert a placeholder row
                            db.add(models.WorkspaceMapping(
                                legacy_item_id=item_id,
                                legacy_feature_id=legacy_attr,
                                legacy_value="",
                                new_attribute_id=new_attr,
                                new_value="",
                                attribute_type=attr_type,
                                mapped_from=mapped_from,
                                signed_on_by_user_id=current_user_id,
                                signed_on_by_username=getattr(current_user, "username", None),
                                signed_on_at=signed_ts,
                                updated_at=now_ts,
                                version=1,
                                created_by=current_user_id,
                                modified_by=current_user_id,
                                modified_at=now_ts,
                            ))
                            workspace_rows_upserted += 1
                        continue

                    for legacy_val, new_val in values_map.items():
                        if not legacy_attr or legacy_val is None:
                            continue
                        existing = (
                            db.query(models.WorkspaceMapping)
                            .filter(
                                models.WorkspaceMapping.legacy_item_id == item_id,
                                models.WorkspaceMapping.legacy_feature_id == legacy_attr,
                                models.WorkspaceMapping.legacy_value == str(legacy_val),
                            )
                            .first()
                        )
                        if existing:
                            existing.new_attribute_id = new_attr
                            existing.new_value = str(new_val)
                            existing.attribute_type = attr_type
                            existing.mapped_from = mapped_from
                            existing.signed_on_by_user_id = current_user_id
                            existing.signed_on_by_username = getattr(current_user, "username", None)
                            existing.signed_on_at = signed_ts
                            existing.updated_at = now_ts
                            existing.modified_by = current_user_id
                            existing.modified_at = now_ts
                            existing.version = (existing.version or 0) + 1
                        else:
                            db.add(models.WorkspaceMapping(
                                legacy_item_id=item_id,
                                legacy_feature_id=legacy_attr,
                                legacy_value=str(legacy_val),
                                new_attribute_id=new_attr,
                                new_value=str(new_val),
                                attribute_type=attr_type,
                                mapped_from=mapped_from,
                                signed_on_by_user_id=current_user_id,
                                signed_on_by_username=getattr(current_user, "username", None),
                                signed_on_at=signed_ts,
                                updated_at=now_ts,
                                version=1,
                                created_by=current_user_id,
                                modified_by=current_user_id,
                                modified_at=now_ts,
                            ))
                        workspace_rows_upserted += 1

        logger.info("sync_state: upserted %d workspace mapping rows", workspace_rows_upserted)

    # Persist mappingTypeConfig to app_config (the only remaining config key)
    if "mappingTypeConfig" in incoming:
        cfg = db.query(models.AppConfig).filter(models.AppConfig.id == 1).first()
        if not cfg:
            cfg = models.AppConfig(id=1, mapping_type_config=incoming["mappingTypeConfig"])
            db.add(cfg)
        else:
            cfg.mapping_type_config = incoming["mappingTypeConfig"]

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

    persisted_global_mappings = db.query(func.count(models.GlobalMapping.id)).scalar() or 0

    invalidate_metrics_cache()
    await broadcast_sync(actor_id=f"USR-{current_user.id}")
    return {
        "ok": True,
        "mappingGenerationJobId": mapping_generation_job_id,
        "mappingsReceived": len(mappings_payload),
        "globalMappingsInserted": int(global_mappings_inserted),
        "globalMappingsUpdated": int(global_mappings_updated),
        "globalMappingsDeleted": int(global_mappings_deleted),
        "globalMappingsCollapsed": int(global_mappings_collapsed),
        "globalMappingsTotal": int(persisted_global_mappings),
    }

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


@router.get("/dashboard/metrics")
def get_dashboard_metrics(
    category: Optional[str] = None,
    productType: Optional[str] = None,
    productLine: Optional[str] = Query(None, alias="productLine"),
    priority: Optional[int] = Query(None, alias="priority"),
    includeExcluded: bool = Query(False, alias="includeExcluded"),
    forceRecompute: bool = Query(False, alias="forceRecompute"),
    db: Session = Depends(get_db),
):
    selected_product_type = productType or productLine

    # --- check cache (cache both variants from one computation) ---
    cache_key = _make_metrics_cache_key(category, selected_product_type, includeExcluded, priority)
    fingerprint = _data_fingerprint(db)

    if not forceRecompute and cache_key in _metrics_cache and _metrics_cache_fingerprint.get(cache_key) == fingerprint:
        return _metrics_cache[cache_key]

    # --- Get included attribute types from mappingTypeConfig ---
    included_type_set = _get_included_type_set(db)

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
    if priority is not None:
        items_query = items_query.filter(models.BomItem.priority == priority)
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
    if priority is not None:
        filter_clause += " AND bi.priority = :priority"
        bind_params["priority"] = priority

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
        elif new_attr and new_attr != "UNMAPPED" and (num_values == 0 or num_mapped >= num_values):
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
        # Use the workspace_mappings table which already holds resolved per-item
        # per-feature per-value rows.  A feature is "mapped" only when every
        # value row has a non-blank new_value.
        #
        # Build included-type filter so we can skip ignored attribute types.
        included_type_set = _get_included_type_set(db)

        # Initialise every BOM item so items without any workspace rows still
        # appear in the output.
        all_item_ids = [row[0] for row in db.query(models.BomItem.item_id).all()]
        item_stats: Dict[str, Dict[str, int]] = {
                item_id: {"mapped": 0, "not_required": 0, "total": 0}
                for item_id in all_item_ids
        }

        # Use a SQL aggregate query on workspace_mappings to compute per-feature
        # status without loading 2M+ rows into Python.
        # For each (item, feature) group we need:
        #   - the attribute type (to check included_type_set)
        #   - the target attribute (new_attribute_id)
        #   - whether ANY row has an empty new_value (means not fully mapped)
        from sqlalchemy import func, case, literal_column
        WM = models.WorkspaceMapping
        has_empty_val = func.sum(
                case(
                        (func.trim(func.coalesce(WM.new_value, literal_column("''"))) == literal_column("''"), 1),
                        else_=0,
                )
        ).label("empty_count")

        feature_q = (
                db.query(
                        WM.legacy_item_id,
                        WM.legacy_feature_id,
                        func.max(WM.new_attribute_id).label("new_attribute_id"),
                        func.max(WM.attribute_type).label("attribute_type"),
                        has_empty_val,
                )
                .group_by(WM.legacy_item_id, WM.legacy_feature_id)
                .all()
        )

        for row in feature_q:
                item_id = row.legacy_item_id
                stats = item_stats.get(item_id)
                if stats is None:
                        continue
                attr_type = (row.attribute_type or "").strip().lower()
                if included_type_set and attr_type and attr_type not in included_type_set:
                        continue
                target = (row.new_attribute_id or "").strip().upper()
                stats["total"] += 1
                if target == "NOT REQUIRED":
                        stats["not_required"] += 1
                elif target and target != "UNMAPPED":
                        if row.empty_count == 0:
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


@router.post("/attribute-options")
def attribute_options(
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
):
    """Return ordered dropdown options for a feature's target attribute selector.

    Request body:
        featureId  – legacy feature ID (required)
        classId    – optional PLM class; when absent returns top 20 across all classes
        search     – optional substring filter applied to attribute IDs

    Response:
        globalCandidates  – target attributes from global mappings for this feature
        classAttributes   – top 20 attributes from the class (or all classes if no classId)
        warningIds        – global candidates that are NOT in the class attribute list
    """
    feature_id = str(payload.get("featureId") or "").strip()
    class_id = str(payload.get("classId") or "").strip() or None
    search = str(payload.get("search") or "").strip().lower()[:MAX_SEARCH_LENGTH]

    # ── 1. Global candidates for this feature ────────────────────────
    global_candidates: List[str] = []
    rows = db.query(models.GlobalMapping).all()
    for m in rows:
        m_fids = getattr(m, "legacy_feature_ids", []) or []
        if feature_id in m_fids:
            parts = [
                p.strip()
                for p in (getattr(m, "new_attribute_id", "") or "").replace(" ", "").split(";")
                if p.strip() and p.strip().upper() != "UNMAPPED"
            ]
            global_candidates.extend(parts)
    # Deduplicate preserving order
    seen: set = set()
    deduped: List[str] = []
    for c in global_candidates:
        key = c.upper().replace(" ", "")
        if key not in seen:
            seen.add(key)
            deduped.append(c)
    global_candidates = deduped

    # ── 2. Classification attributes ─────────────────────────────────
    class_attr_ids: List[str] = []
    class_attr_key_set: set = set()

    if class_id:
        cls_row = (
            db.query(models.Classification)
            .filter(models.Classification.class_id == class_id)
            .first()
        )
        if cls_row and cls_row.attributes:
            for attr in cls_row.attributes:
                aid = attr.get("attributeId") or attr.get("attribute_id") or ""
                if aid:
                    class_attr_ids.append(aid)
                    class_attr_key_set.add(aid.upper().replace(" ", ""))
    else:
        # No class → collect top 20 distinct attributes across ALL classes
        all_cls = db.query(models.Classification).all()
        attr_freq: Dict[str, int] = {}
        attr_canonical: Dict[str, str] = {}
        for cls_row in all_cls:
            for attr in (cls_row.attributes or []):
                aid = attr.get("attributeId") or attr.get("attribute_id") or ""
                if not aid:
                    continue
                key = aid.upper().replace(" ", "")
                attr_freq[key] = attr_freq.get(key, 0) + 1
                if key not in attr_canonical:
                    attr_canonical[key] = aid
        sorted_keys = sorted(attr_freq.keys(), key=lambda k: -attr_freq[k])
        for key in sorted_keys[:20]:
            class_attr_ids.append(attr_canonical[key])
            class_attr_key_set.add(key)

    # ── 3. Apply search filter ────────────────────────────────────────
    if search:
        global_candidates = [c for c in global_candidates if search in c.lower()]
        class_attr_ids = [a for a in class_attr_ids if search in a.lower()]

        # When searching, also scan ALL classifications for matching attributes
        # so the user can find any attribute even if it's not in the current class.
        all_cls_rows = db.query(models.Classification).all()
        extra_seen: set = set(a.upper().replace(" ", "") for a in class_attr_ids)
        extra_matches: List[str] = []
        for cls_row in all_cls_rows:
            for attr in (cls_row.attributes or []):
                aid = attr.get("attributeId") or attr.get("attribute_id") or ""
                if not aid:
                    continue
                key = aid.upper().replace(" ", "")
                if key not in extra_seen and search in aid.lower():
                    extra_seen.add(key)
                    extra_matches.append(aid)
        class_attr_ids.extend(extra_matches)

    class_attr_ids = class_attr_ids[:20]

    # ── 4. Warning IDs: global candidates not in the class ────────────
    # Only warn when a specific class is provided; for unclassified items
    # there is no class to be "not in".
    warning_ids = []
    if class_id:
        warning_ids = [
            c for c in global_candidates
            if c.upper().replace(" ", "") not in class_attr_key_set
        ]

    return {
        "globalCandidates": global_candidates,
        "classAttributes": class_attr_ids,
        "warningIds": warning_ids,
    }


@router.post("/global-mappings/by-features")
def global_mappings_by_features(
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return global mappings grouped by feature ID for a list of features."""
    feature_ids = payload.get("featureIds") or []
    if not isinstance(feature_ids, list) or len(feature_ids) > 500:
        raise HTTPException(status_code=400, detail="featureIds must be a list of up to 500 strings")

    feature_ids = [str(fid).strip() for fid in feature_ids if fid]
    if not feature_ids:
        return {}

    rows = db.query(models.GlobalMapping).all()
    result: Dict[str, list] = {fid: [] for fid in feature_ids}
    fid_set = set(feature_ids)

    for m in rows:
        m_fids = getattr(m, "legacy_feature_ids", []) or []
        for fid in m_fids:
            if fid in fid_set:
                result[fid].append({
                    "id": getattr(m, "id", None),
                    "legacyFeatureIds": m_fids,
                    "newAttributeId": getattr(m, "new_attribute_id", ""),
                    "attributeType": getattr(m, "attribute_type", "") or "",
                    "valueMappings": getattr(m, "value_mappings", {}) or {},
                    "version": getattr(m, "version", 1),
                })

    return result


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
            "id": getattr(m, "id", None),
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


# ---------------------------------------------------------------------------
# BOM Hierarchy endpoints
# ---------------------------------------------------------------------------

@router.get("/bom/hierarchy")
def get_bom_hierarchy(
    limit: int = Query(500, ge=1, le=10000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return all hierarchy rows (paginated)."""
    total = db.query(models.BomHierarchy).count()
    rows = (
        db.query(models.BomHierarchy)
        .order_by(models.BomHierarchy.id)
        .offset(offset)
        .limit(limit)
        .all()
    )
    items = [
        {
            "id": row.id,
            "level": row.level,
            "parentBom": row.parent_bom,
            "itemId": row.item_id,
            "description": row.description,
            "qty": row.qty,
            "unit": row.unit,
            "condition": row.condition,
            "formula": row.formula,
            "createdAt": row.created_at,
            "createdBy": row.created_by,
        }
        for row in rows
    ]
    return {"items": items, "total": total}


@router.post("/bom/hierarchy")
def save_bom_hierarchy(
    payload: List[Dict[str, Any]] = Body(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Bulk save hierarchy rows (replaces existing data)."""
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="admin role required to save BOM hierarchy")

    _audit(db, current_user, "save-bom-hierarchy", f"{len(payload)} rows")

    db.query(models.BomHierarchy).delete()

    import time as _time

    now_ts = _time.time()
    user_id = f"USR-{current_user.id}"

    rows_to_insert: List[Dict[str, Any]] = []
    for item in payload:
        item_id = item.get("itemId") or item.get("item_id") or ""
        if not item_id:
            continue
        raw_level = item.get("level")
        level = int(raw_level) if raw_level is not None and str(raw_level).strip() != "" else None
        raw_qty = item.get("qty")
        qty = float(raw_qty) if raw_qty is not None and str(raw_qty).strip() != "" else None

        parent_bom = (item.get("parentBom") or item.get("parent_bom") or "").strip() or None

        rows_to_insert.append(
            {
                "level": level,
                "parent_bom": parent_bom,
                "item_id": str(item_id).strip(),
                "description": (item.get("description") or "").strip() or None,
                "qty": qty,
                "unit": (item.get("unit") or "").strip() or None,
                "condition": (item.get("condition") or "").strip() or None,
                "formula": (item.get("formula") or "").strip() or None,
                "created_at": now_ts,
                "created_by": user_id,
            }
        )

    if rows_to_insert:
        db.bulk_insert_mappings(models.BomHierarchy, rows_to_insert)

    db.commit()
    return {"ok": True, "rowsInserted": len(rows_to_insert)}


@router.get("/bom/hierarchy/search")
def search_bom_hierarchy_items(
    q: str = "",
    limit: int = 30,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Search distinct BOM item IDs in the hierarchy table.

    Returns items that appear either as a parent_bom or as an item_id,
    filtered by a case-insensitive prefix/substring search on the ID or
    description.  Results include the description of the first matching row.
    """
    q = _validate_search(q)
    limit = max(1, min(limit, 200))

    # Collect distinct (item_id, description) from hierarchy – we want items
    # that can be top-level roots AND regular BOM items.
    base = db.query(
        models.BomHierarchy.item_id,
        models.BomHierarchy.description,
    )
    if q:
        pattern = f"%{q}%"
        base = base.filter(
            (models.BomHierarchy.item_id.ilike(pattern))
            | (models.BomHierarchy.description.ilike(pattern))
        )
    # Get distinct item_ids with their first description
    from sqlalchemy import func as sa_func
    rows = (
        base.group_by(models.BomHierarchy.item_id)
        .with_entities(
            models.BomHierarchy.item_id,
            sa_func.max(models.BomHierarchy.description).label("description"),
        )
        .order_by(models.BomHierarchy.item_id)
        .limit(limit)
        .all()
    )

    # Also search parent_bom values (root assemblies that may not appear as item_id)
    parent_base = db.query(models.BomHierarchy.parent_bom).filter(
        models.BomHierarchy.parent_bom.isnot(None)
    )
    if q:
        parent_base = parent_base.filter(models.BomHierarchy.parent_bom.ilike(f"%{q}%"))
    parent_ids = {r[0] for r in parent_base.distinct().limit(limit).all() if r[0]}

    # Merge: item_id results + parent_bom-only results
    seen = set()
    results = []
    for r in rows:
        seen.add(r.item_id)
        results.append({"itemId": r.item_id, "description": r.description or ""})
    for pid in sorted(parent_ids):
        if pid not in seen:
            results.append({"itemId": pid, "description": ""})

    results = results[:limit]
    return {"items": results, "total": len(results)}


@router.get("/bom/hierarchy/roots")
def get_bom_hierarchy_roots(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return distinct root BOM item IDs (items that appear as parent_bom at level 1)."""
    # Distinct parent_bom values where level == 1 (the root assemblies)
    roots_q = (
        db.query(models.BomHierarchy.parent_bom)
        .filter(models.BomHierarchy.level == 1)
        .filter(models.BomHierarchy.parent_bom.isnot(None))
        .distinct()
        .all()
    )
    root_ids = sorted(set(r[0] for r in roots_q if r[0]))

    # Also get all distinct item_ids that appear as a parent_bom (they are BOM nodes)
    bom_nodes_q = (
        db.query(models.BomHierarchy.parent_bom)
        .filter(models.BomHierarchy.parent_bom.isnot(None))
        .distinct()
        .all()
    )
    all_bom_nodes = sorted(set(r[0] for r in bom_nodes_q if r[0]))

    return {"roots": root_ids, "allBomNodes": all_bom_nodes}


@router.get("/bom/hierarchy/children/{parent_id}")
def get_bom_hierarchy_children(
    parent_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return all hierarchy rows whose parent_bom matches {parent_id}."""
    rows = (
        db.query(models.BomHierarchy)
        .filter(models.BomHierarchy.parent_bom == parent_id.strip())
        .order_by(models.BomHierarchy.id)
        .all()
    )
    items = [
        {
            "id": row.id,
            "level": row.level,
            "parentBom": row.parent_bom,
            "itemId": row.item_id,
            "description": row.description,
            "qty": row.qty,
            "unit": row.unit,
            "condition": row.condition,
            "formula": row.formula,
        }
        for row in rows
    ]
    return {"items": items, "total": len(items)}


@router.delete("/bom/hierarchy")
def wipe_bom_hierarchy(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Delete all BOM hierarchy rows."""
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="admin role required to wipe BOM hierarchy")
    _audit(db, current_user, "wipe-bom-hierarchy", "")
    db.query(models.BomHierarchy).delete()
    db.commit()
    return {"ok": True}


@router.post("/global-mappings/upsert")
def upsert_global_mapping(
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Upsert exactly one global mapping record.

    This endpoint is intentionally isolated from the bulk /sync path so a
    single-row edit in the UI can never mutate unrelated mappings.
    """
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="Only admins may modify global mappings")

    raw_id = payload.get("id")
    raw_original_id = payload.get("_originalId")
    mapping_id: Optional[int] = None
    preferred_id = raw_id if raw_id is not None else raw_original_id
    if preferred_id is not None:
        try:
            parsed = int(preferred_id)
            if parsed > 0:
                mapping_id = parsed
        except (TypeError, ValueError):
            mapping_id = None

    legacy_feature_ids = _normalize_legacy_feature_ids(payload.get("legacyFeatureIds") or [])
    new_attribute_id = str(payload.get("newAttributeId") or "").strip()
    attribute_type = str(payload.get("attributeType") or "").strip().lower()
    value_mappings = _normalize_value_mappings(payload.get("valueMappings") or {})
    original_legacy_feature_ids = _normalize_legacy_feature_ids(payload.get("_originalLegacyFeatureIds") or [])
    original_new_attribute_id = str(payload.get("_originalNewAttributeId") or "").strip()
    current_user_id = f"USR-{current_user.id}"
    now_ts = time.time()

    row: Optional[models.GlobalMapping] = None
    if mapping_id is not None:
        row = db.query(models.GlobalMapping).filter(models.GlobalMapping.id == mapping_id).first()

    if row is None and original_legacy_feature_ids is not None:
        original_natural_key = _global_mapping_natural_key(original_legacy_feature_ids, original_new_attribute_id)
        matching_rows = []
        for existing_row in db.query(models.GlobalMapping).all():
            existing_key = _global_mapping_natural_key(
                _normalize_legacy_feature_ids(getattr(existing_row, "legacy_feature_ids", []) or []),
                str(getattr(existing_row, "new_attribute_id", "") or "").strip(),
            )
            if existing_key == original_natural_key:
                matching_rows.append(existing_row)
        if matching_rows:
            row = max(matching_rows, key=_global_mapping_model_rank)

    if row is None:
        current_natural_key = _global_mapping_natural_key(legacy_feature_ids, new_attribute_id)
        matching_rows = []
        for existing_row in db.query(models.GlobalMapping).all():
            existing_key = _global_mapping_natural_key(
                _normalize_legacy_feature_ids(getattr(existing_row, "legacy_feature_ids", []) or []),
                str(getattr(existing_row, "new_attribute_id", "") or "").strip(),
            )
            if existing_key == current_natural_key:
                matching_rows.append(existing_row)
        if matching_rows:
            row = max(matching_rows, key=_global_mapping_model_rank)

    if row is None:
        row = models.GlobalMapping(
            legacy_feature_ids=legacy_feature_ids,
            new_attribute_id=new_attribute_id,
            attribute_type=attribute_type,
            value_mappings=value_mappings,
            version=1,
            created_by=current_user_id,
            modified_by=current_user_id,
            modified_at=now_ts,
        )
        db.add(row)
        action = "inserted"
    else:
        if _global_mapping_row_changed(
            row,
            legacy_feature_ids,
            new_attribute_id,
            attribute_type,
            value_mappings,
        ):
            existing_version = int(getattr(row, "version", 1) or 1)
            row.legacy_feature_ids = legacy_feature_ids
            row.new_attribute_id = new_attribute_id
            row.attribute_type = attribute_type
            row.value_mappings = value_mappings
            row.version = existing_version + 1
            row.modified_by = current_user_id
            row.modified_at = now_ts
            action = "updated"
        else:
            action = "unchanged"

    db.commit()
    db.refresh(row)
    invalidate_metrics_cache()

    return {
        "ok": True,
        "action": action,
        "item": {
            "id": getattr(row, "id", None),
            "legacyFeatureIds": getattr(row, "legacy_feature_ids", []) or [],
            "newAttributeId": getattr(row, "new_attribute_id", "") or "",
            "attributeType": getattr(row, "attribute_type", "") or "",
            "valueMappings": getattr(row, "value_mappings", {}) or {},
            "version": getattr(row, "version", 1),
            "createdBy": getattr(row, "created_by", None),
            "modifiedBy": getattr(row, "modified_by", None),
            "modifiedAt": getattr(row, "modified_at", None),
        },
        "globalMappingsTotal": int(db.query(func.count(models.GlobalMapping.id)).scalar() or 0),
    }


@router.post("/global-mappings/deduplicate")
def deduplicate_global_mappings(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Consolidate duplicate global mappings sharing the same feature-level key.

    Keeps the best row per feature (prefers non-empty attribute_type, then most
    recently modified), merges value_mappings from duplicates, and deletes the
    inferior rows.
    """
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="Only admins may deduplicate global mappings")

    removed = _deduplicate_global_mappings_in_db(db)
    invalidate_metrics_cache()
    remaining = int(db.query(func.count(models.GlobalMapping.id)).scalar() or 0)
    return {"ok": True, "duplicatesRemoved": removed, "globalMappingsTotal": remaining}


@router.delete("/global-mappings/{mapping_id}")
def delete_global_mapping(
    mapping_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Delete exactly one global mapping record by id."""
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="Only admins may modify global mappings")

    row = db.query(models.GlobalMapping).filter(models.GlobalMapping.id == mapping_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Global mapping not found")

    db.delete(row)
    db.commit()
    invalidate_metrics_cache()

    return {
        "ok": True,
        "deletedId": mapping_id,
        "globalMappingsTotal": int(db.query(func.count(models.GlobalMapping.id)).scalar() or 0),
    }


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


@router.get("/classifications/search")
def search_classification_names(
    search: Optional[str] = None,
    limit: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """Lightweight search returning only classId + className (no attributes)."""
    search = _validate_search(search)
    query = db.query(
        models.Classification.class_id,
        models.Classification.class_name,
    )
    if search:
        like = f"%{search}%"
        query = query.filter(
            or_(
                models.Classification.class_id.ilike(like),
                models.Classification.class_name.ilike(like),
            )
        )
    query = query.order_by(models.Classification.class_id).limit(limit)
    rows = query.all()
    return {"items": [{"classId": r[0], "className": r[1] or r[0]} for r in rows]}


@router.get("/classifications/{class_id}")
def get_classification_by_id(
    class_id: str,
    db: Session = Depends(get_db),
):
    """Return a single classification with its attributes."""
    record = db.query(models.Classification).filter(models.Classification.class_id == class_id).first()
    if not record:
        raise HTTPException(status_code=404, detail=f"Classification '{class_id}' not found")
    return {
        "classId": record.class_id,
        "className": record.class_name,
        "attributes": record.attributes or [],
    }


# ---------------------------------------------------------------------------
# Item class-attribute values (replaces blob classAttributeValues)
# ---------------------------------------------------------------------------

@router.get("/items/{item_id}/class-attribute-values")
def get_class_attribute_values(
    item_id: str,
    db: Session = Depends(get_db),
    _current_user: models.User = Depends(get_current_user),
):
    rows = (
        db.query(models.ItemClassAttributeValue)
        .filter(models.ItemClassAttributeValue.item_id == item_id)
        .all()
    )
    result: Dict[str, str] = {}
    class_id: Optional[str] = None
    for r in rows:
        result[r.attribute_id] = r.value or ""
        class_id = r.class_id
    return {"classId": class_id, "values": result}


@router.put("/items/{item_id}/class-attribute-values")
def put_class_attribute_values(
    item_id: str,
    body: ClassAttributeValuesIn,
    db: Session = Depends(get_db),
    _current_user: models.User = Depends(get_current_user),
):
    new_class_id = body.classId
    prev_class_id = body.previousClassId
    incoming_values = body.values  # Dict[str, str]

    # If class changed, handle shared-attribute retention
    if prev_class_id and prev_class_id != new_class_id:
        existing = (
            db.query(models.ItemClassAttributeValue)
            .filter(
                models.ItemClassAttributeValue.item_id == item_id,
                models.ItemClassAttributeValue.class_id == prev_class_id,
            )
            .all()
        )
        incoming_attr_ids = set(incoming_values.keys())
        for row in existing:
            if row.attribute_id in incoming_attr_ids:
                # shared attribute – update class_id + value
                row.class_id = new_class_id
                row.value = incoming_values.pop(row.attribute_id, row.value)
            else:
                # old-only attribute – remove
                db.delete(row)
        # remaining incoming keys are new-only attributes – insert
        for attr_id, val in incoming_values.items():
            db.add(models.ItemClassAttributeValue(
                item_id=item_id,
                class_id=new_class_id,
                attribute_id=attr_id,
                value=val,
            ))
    else:
        # Same class or no previous – simple upsert
        for attr_id, val in incoming_values.items():
            existing_row = (
                db.query(models.ItemClassAttributeValue)
                .filter(
                    models.ItemClassAttributeValue.item_id == item_id,
                    models.ItemClassAttributeValue.class_id == new_class_id,
                    models.ItemClassAttributeValue.attribute_id == attr_id,
                )
                .first()
            )
            if existing_row:
                existing_row.value = val
            else:
                db.add(models.ItemClassAttributeValue(
                    item_id=item_id,
                    class_id=new_class_id,
                    attribute_id=attr_id,
                    value=val,
                ))

    db.commit()
    return {"ok": True}


@router.delete("/items/{item_id}/class-attribute-values")
def delete_class_attribute_values(
    item_id: str,
    db: Session = Depends(get_db),
    _current_user: models.User = Depends(get_current_user),
):
    """Delete all class-attribute values for an item (e.g. when reverting to legacy view)."""
    count = (
        db.query(models.ItemClassAttributeValue)
        .filter(models.ItemClassAttributeValue.item_id == item_id)
        .delete(synchronize_session="fetch")
    )
    db.commit()
    return {"ok": True, "deleted": count}


@router.post("/reset")
def reset(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # only admins may reset the application state
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="admin role required to reset state")
    cfg = db.query(models.AppConfig).filter(models.AppConfig.id == 1).first()
    if cfg:
        cfg.mapping_type_config = None

    # also nuke any classifications, BOM, mappings and local overrides so
    # reset truly returns to defaults
    db.query(models.ItemClassAttributeValue).delete()
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
