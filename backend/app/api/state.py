from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import func, or_, cast, case, String, literal_column, text as sa_text
from sqlalchemy.exc import IntegrityError, OperationalError
from typing import Dict, List, Any, Optional, Set
import io, csv, time, hashlib, asyncio, logging, json
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


def _build_all_candidates_by_feature(mapping_rows: List[models.GlobalMapping]) -> Dict[str, List[str]]:
    """Return *all* distinct target attribute IDs per feature, ordered by rank (best first).

    When a feature maps to multiple global mappings the caller should leave
    ``new_attribute_id`` blank and store the full list in
    ``candidate_attribute_ids_json``.
    """
    candidates_by_feature: Dict[str, List[str]] = {}
    for mapping in sorted(mapping_rows, key=_global_mapping_model_rank, reverse=True):
        target = (getattr(mapping, "new_attribute_id", "") or "").strip()
        if not target:
            continue
        for feature_id in (getattr(mapping, "legacy_feature_ids", []) or []):
            normalized = str(feature_id or "").strip()
            if not normalized:
                continue
            if normalized not in candidates_by_feature:
                candidates_by_feature[normalized] = []
            if target not in candidates_by_feature[normalized]:
                candidates_by_feature[normalized].append(target)
    return candidates_by_feature


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
        candidates_by_feature = _build_all_candidates_by_feature(scan_db.query(models.GlobalMapping).all())

        # Build exclusion indexes from global mappings
        _gm_status_by_feature: Dict[str, str] = {}  # feature_id -> mapping status
        _gm_ignored_values_by_feature: Dict[str, Set[str]] = {}  # feature_id -> ignored values
        for gm in scan_db.query(models.GlobalMapping).all():
            gm_status = (getattr(gm, "status", "active") or "active").strip().lower()
            gm_ignored = set(getattr(gm, "ignored_values", []) or [])
            for fid in (getattr(gm, "legacy_feature_ids", []) or []):
                nfid = str(fid or "").strip()
                if not nfid:
                    continue
                if gm_status != "active":
                    _gm_status_by_feature[nfid] = gm_status
                if gm_ignored:
                    _gm_ignored_values_by_feature.setdefault(nfid, set()).update(gm_ignored)

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
            candidates = candidates_by_feature.get(feat_feature_id, [])
            if len(candidates) > 1:
                # Multiple global targets — leave confirmed blank, store candidates
                target_attr = ""
                candidates_json = candidates
            elif len(candidates) == 1:
                target_attr = candidates[0]
                candidates_json = candidates
            else:
                target_attr = ""
                candidates_json = None
            attr_type = (getattr(mapping, "attribute_type", "") or "").strip() if mapping else ""
            feat_condition = (getattr(feat, "condition", "") or "").strip() or None
            feat_formula = (getattr(feat, "formula", "") or "").strip() or None
            value_mappings = getattr(mapping, "value_mappings", {}) if mapping else {}

            # Determine mapping-level exclusion status
            feature_gm_status = _gm_status_by_feature.get(feat_feature_id)  # deprecated/ignored or None
            feature_ignored_values = _gm_ignored_values_by_feature.get(feat_feature_id, set())

            raw_values = getattr(feat, "values", []) or []
            till_dates: Dict[str, str] = {}
            if isinstance(raw_values, dict):
                values = [str(v) for v in (raw_values.get("values") or [])]
                till_dates = raw_values.get("valueTillDates", {}) or {}
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
                        "value_status": feature_gm_status,
                        "signed_on_by_user_id": job.triggered_by_user_id,
                        "signed_on_by_username": job.triggered_by_username,
                        "signed_on_at": signed_ts,
                        "updated_at": time.time(),
                        "candidate_attribute_ids_json": candidates_json,
                    }
                )
                generated_rows += 1
            else:
                for legacy_value in values:
                    # Determine per-value exclusion status
                    val_status = None
                    if feature_gm_status:
                        # Entire mapping is deprecated/ignored
                        val_status = feature_gm_status
                    elif legacy_value in feature_ignored_values:
                        val_status = "ignored"
                    else:
                        td_str = till_dates.get(legacy_value)
                        if td_str and str(td_str).strip():
                            val_status = "discontinued"

                    if val_status:
                        # Excluded row: keep target attr, set value to NOT REQUIRED
                        append_row(
                            {
                                "legacy_item_id": legacy_item_id,
                                "legacy_feature_id": getattr(feat, "feature_id", "") or "",
                                "legacy_value": str(legacy_value),
                                "new_attribute_id": target_attr,
                                "new_value": "NOT REQUIRED",
                                "attribute_type": attr_type,
                                "condition": feat_condition,
                                "formula": feat_formula,
                                "mapped_from": "global",
                                "value_status": val_status,
                                "signed_on_by_user_id": job.triggered_by_user_id,
                                "signed_on_by_username": job.triggered_by_username,
                                "signed_on_at": signed_ts,
                                "updated_at": time.time(),
                                "candidate_attribute_ids_json": candidates_json,
                            }
                        )
                    else:
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
                                "value_status": None,
                                "signed_on_by_user_id": job.triggered_by_user_id,
                                "signed_on_by_username": job.triggered_by_username,
                                "signed_on_at": signed_ts,
                                "updated_at": time.time(),
                                "candidate_attribute_ids_json": candidates_json,
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

        # Build exclusion indexes for combination filtering
        _combo_excluded_features: Set[str] = set()  # features where entire mapping deprecated/ignored
        _combo_ignored_values: Dict[str, Set[str]] = {}  # feature_id -> set of ignored values
        for gm in scan_db.query(models.GlobalMapping).all():
            gm_status = (getattr(gm, "status", "active") or "active").strip().lower()
            gm_ignored = set(getattr(gm, "ignored_values", []) or [])
            for fid in (getattr(gm, "legacy_feature_ids", []) or []):
                nfid = str(fid or "").strip()
                if not nfid:
                    continue
                if gm_status in ("deprecated", "ignored"):
                    _combo_excluded_features.add(nfid)
                if gm_ignored:
                    _combo_ignored_values.setdefault(nfid, set()).update(gm_ignored)

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

            # Skip entirely excluded features (deprecated/ignored mapping)
            if feature_id in _combo_excluded_features:
                processed += 1
                continue

            normalized = _normalize_feature_values(getattr(feat, "values", []))

            # Filter out ignored + discontinued values
            ignored_for_fid = _combo_ignored_values.get(feature_id, set())
            raw_vals_data = getattr(feat, "values", []) or []
            till_dates: Dict[str, str] = {}
            if isinstance(raw_vals_data, dict):
                till_dates = raw_vals_data.get("valueTillDates", {}) or {}

            active_values: List[str] = []
            for v in normalized:
                if v in ignored_for_fid:
                    continue
                td_str = till_dates.get(v)
                if td_str and str(td_str).strip():
                    continue
                active_values.append(v)

            values_key = _make_values_key(active_values)
            combo_key = f"{feature_id}||{values_key}"

            if combo_key not in combos:
                combos[combo_key] = {
                    "feature_id": feature_id,
                    "description": str(getattr(feat, "description", "") or "").strip(),
                    "unit": str(getattr(feat, "unit", "") or "").strip(),
                    "values": active_values,
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
    analysisMode: Optional[bool] = None,
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

    # Analysis mode: one row per feature_id, only features with 2+ combos
    # IMPORTANT: use the already-filtered `base` query so that featureId, priority,
    # attributeType and other filters are respected when picking the representative row.
    if analysisMode:
        filtered_combos = base.with_entities(
            models.FeatureCombination.id,
            models.FeatureCombination.feature_id,
            models.FeatureCombination.item_count,
        ).all()
        by_feature: Dict[str, list] = {}
        for cid, fid, ic in filtered_combos:
            by_feature.setdefault(fid, []).append((cid, ic))
        # Pick one representative (most items) per feature, only for features with 2+ combos
        best_ids: Set[int] = set()
        for fid, combos in by_feature.items():
            if len(combos) < 2:
                continue
            best = max(combos, key=lambda x: (x[1], -x[0]))
            best_ids.add(best[0])
        if not best_ids:
            return {"items": [], "total": 0}
        base = base.filter(models.FeatureCombination.id.in_(best_ids))

    # Also enrich with saved consolidation plan status when in analysis mode
    saved_plans_map: Dict[str, str] = {}
    if analysisMode:
        saved_plans = db.query(
            models.ConsolidationPlan.feature_id,
            models.ConsolidationPlan.strategy,
        ).all()
        saved_plans_map = {fp: st for fp, st in saved_plans}

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
            **({"savedPlanStrategy": saved_plans_map.get(r.feature_id)} if analysisMode else {}),
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


@router.get("/feature-combinations/analysis-variants")
def get_feature_variants(
    feature_id: str = Query(..., alias="featureId"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """On-demand: full variant comparison with product types and subset relationships."""
    combos = (
        db.query(models.FeatureCombination)
        .filter(models.FeatureCombination.feature_id == feature_id)
        .order_by(models.FeatureCombination.item_count.desc())
        .all()
    )
    if not combos:
        raise HTTPException(status_code=404, detail="no combinations found")

    union_values: Set[str] = set()
    variants: List[Dict[str, Any]] = []
    for c in combos:
        vals = set(c.normalized_values_json or [])
        item_ids = c.item_ids_json or []
        union_values.update(vals)

        pt_set: Set[str] = set()
        if item_ids:
            pts = (
                db.query(models.BomItem.product_type)
                .filter(
                    models.BomItem.item_id.in_(item_ids),
                    models.BomItem.product_type.isnot(None),
                    models.BomItem.product_type != "",
                )
                .distinct()
                .all()
            )
            pt_set = {r[0] for r in pts}

        variants.append({
            "comboId": c.id,
            "values": sorted(vals),
            "itemCount": c.item_count,
            "priorities": c.priorities_json or [],
            "productTypes": sorted(pt_set),
            "valuesSet": vals,
        })

    for v in variants:
        vs = v["valuesSet"]
        v["isSubsetOf"] = [o["comboId"] for o in variants if o["comboId"] != v["comboId"] and vs < o["valuesSet"]]
        v["isSupersetOf"] = [o["comboId"] for o in variants if o["comboId"] != v["comboId"] and vs > o["valuesSet"]]
        v["noiseIfUnion"] = len(union_values) - len(vs)
        v["noiseItems"] = v["itemCount"] * (len(union_values) - len(vs))

    serialized = [{k: v for k, v in var.items() if k != "valuesSet"} for var in variants]
    return {"featureId": feature_id, "variants": serialized, "unionValues": sorted(union_values)}


@router.get("/feature-combinations/analysis-cross-features")
def get_cross_feature_matches(
    feature_id: str = Query(..., alias="featureId"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """On-demand: cross-feature matches with overlapping value sets."""
    combos = (
        db.query(models.FeatureCombination)
        .filter(models.FeatureCombination.feature_id == feature_id)
        .all()
    )
    if not combos:
        raise HTTPException(status_code=404, detail="no combinations found")

    union_values: Set[str] = set()
    for c in combos:
        union_values.update(c.normalized_values_json or [])

    other_features: Dict[str, Set[str]] = {}
    other_combos = (
        db.query(
            models.FeatureCombination.feature_id,
            models.FeatureCombination.normalized_values_json,
        )
        .filter(models.FeatureCombination.feature_id != feature_id)
        .all()
    )
    for of_fid, of_vals_json in other_combos:
        other_features.setdefault(of_fid, set()).update(of_vals_json or [])

    cross_matches: List[Dict[str, Any]] = []
    for of_fid, of_union in other_features.items():
        if not of_union:
            continue
        intersection = union_values & of_union
        if not intersection:
            continue
        overlap_pct = round(len(intersection) / max(len(union_values), len(of_union)) * 100)
        if overlap_pct < 50:
            continue
        if of_union == union_values:
            rel = "identical"
        elif of_union < union_values:
            rel = "subset"
        elif of_union > union_values:
            rel = "superset"
        else:
            rel = "overlap"
        cross_matches.append({
            "featureId": of_fid,
            "unionValues": sorted(of_union),
            "relationship": rel,
            "overlapPercent": overlap_pct,
        })

    cross_matches.sort(key=lambda x: (-x["overlapPercent"], x["featureId"]))
    return {"featureId": feature_id, "crossFeatureMatches": cross_matches[:20]}


@router.get("/feature-combinations/analysis/{feature_id:path}")
def get_feature_consolidation_analysis(
    feature_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Lightweight consolidation analysis: summary + merge options only.

    Variant comparison and cross-feature matches are loaded on demand
    via separate endpoints.
    """
    combos = (
        db.query(models.FeatureCombination)
        .filter(models.FeatureCombination.feature_id == feature_id)
        .order_by(models.FeatureCombination.item_count.desc())
        .all()
    )
    if not combos:
        raise HTTPException(status_code=404, detail="no combinations found for this feature")

    description = combos[0].description or ""

    # Build lightweight variant data (no product type queries, no subset computation)
    variant_sets: List[Set[str]] = []
    all_item_ids: Set[str] = set()
    union_values: Set[str] = set()
    variant_item_counts: List[int] = []
    variant_values_sorted: List[List[str]] = []
    for c in combos:
        vals = set(c.normalized_values_json or [])
        item_ids = c.item_ids_json or []
        all_item_ids.update(item_ids)
        union_values.update(vals)
        variant_sets.append(vals)
        variant_item_counts.append(c.item_count)
        variant_values_sorted.append(sorted(vals))

    sorted_union = sorted(union_values)

    # --- Merge Options (lightweight — just set math) ---
    # 1. Full Union
    full_union_noise = 0
    full_union_max = 0
    for i, vs in enumerate(variant_sets):
        extra = len(union_values) - len(vs)
        full_union_noise += extra * variant_item_counts[i]
        full_union_max = max(full_union_max, extra)

    # 2. Subset Merge
    remaining = list(range(len(variant_sets)))
    canonical_groups: List[List[int]] = []
    while remaining:
        best_idx = max(remaining, key=lambda i: len(variant_sets[i]))
        best_set = variant_sets[best_idx]
        group = [best_idx]
        new_remaining = []
        for idx in remaining:
            if idx == best_idx:
                continue
            if variant_sets[idx] <= best_set:
                group.append(idx)
            else:
                new_remaining.append(idx)
        canonical_groups.append(group)
        remaining = new_remaining

    subset_canonical_lists = []
    subset_noise = 0
    subset_max_noise = 0
    for group in canonical_groups:
        canon_vals = sorted(set().union(*(variant_sets[i] for i in group)))
        subset_canonical_lists.append(canon_vals)
        for i in group:
            extra = len(canon_vals) - len(variant_sets[i])
            subset_noise += extra * variant_item_counts[i]
            subset_max_noise = max(subset_max_noise, extra)

    merge_options = [
        {
            "label": "Full Union",
            "canonicalValues": [sorted_union],
            "listsNeeded": 1,
            "totalNoise": full_union_noise,
            "maxNoisePerItem": full_union_max,
        },
        {
            "label": "Subset Merge",
            "canonicalValues": subset_canonical_lists,
            "listsNeeded": len(canonical_groups),
            "totalNoise": subset_noise,
            "maxNoisePerItem": subset_max_noise,
        },
        {
            "label": "No Merge",
            "canonicalValues": variant_values_sorted,
            "listsNeeded": len(variant_sets),
            "totalNoise": 0,
            "maxNoisePerItem": 0,
        },
    ]

    return {
        "featureId": feature_id,
        "description": description,
        "totalVariants": len(variant_sets),
        "totalItems": len(all_item_ids),
        "unionValues": sorted_union,
        "variants": [],
        "mergeOptions": merge_options,
        "crossFeatureMatches": [],
    }


# ---------------------------------------------------------------------------
# Consolidation plan: per-feature background computation
# ---------------------------------------------------------------------------

_consolidation_lock = asyncio.Lock()


def _compute_consolidation_plan(feature_id: str, strategy: str, username: str):
    """Synchronous worker: compute consolidation for one feature and save to DB."""
    db = SessionLocal()

    def _safe_commit(session, max_retries: int = 5):
        for attempt in range(1, max_retries + 1):
            try:
                session.commit()
                return
            except OperationalError as exc:
                session.rollback()
                if "database is locked" not in str(exc).lower() or attempt >= max_retries:
                    raise
                time.sleep(0.25 * attempt)

    try:
        combos = (
            db.query(models.FeatureCombination)
            .filter(models.FeatureCombination.feature_id == feature_id)
            .order_by(models.FeatureCombination.item_count.desc())
            .all()
        )
        if not combos:
            plan = db.query(models.ConsolidationPlan).filter(
                models.ConsolidationPlan.feature_id == feature_id
            ).first()
            if plan:
                plan.status = "failed"
                plan.error_message = "no combinations found"
                plan.updated_at = time.time()
                _safe_commit(db)
            return

        # Build variants
        variants = []
        for c in combos:
            vals = set(c.normalized_values_json or [])
            item_ids = c.item_ids_json or []
            variants.append({
                "comboId": c.id,
                "values_set": vals,
                "item_ids": item_ids,
                "item_count": c.item_count,
            })

        # Compute groups based on strategy
        if strategy == "full_union":
            # Single group containing all variants
            canonical_groups = [list(range(len(variants)))]
        elif strategy == "no_merge":
            # Each variant is its own group
            canonical_groups = [[i] for i in range(len(variants))]
        else:
            # subset_merge: greedy — largest absorbs strict subsets
            remaining = list(range(len(variants)))
            canonical_groups = []
            while remaining:
                best_idx = max(remaining, key=lambda i: len(variants[i]["values_set"]))
                best_set = variants[best_idx]["values_set"]
                group = [best_idx]
                new_remaining = []
                for idx in remaining:
                    if idx == best_idx:
                        continue
                    if variants[idx]["values_set"] <= best_set:
                        group.append(idx)
                    else:
                        new_remaining.append(idx)
                canonical_groups.append(group)
                remaining = new_remaining

        # Build result with item details per list
        total_noise = 0
        max_noise_per_item = 0
        lists_result: List[Dict[str, Any]] = []
        canonical_lists: List[List[str]] = []
        item_assignments: List[List[str]] = []

        for gi, group in enumerate(canonical_groups):
            if strategy == "full_union":
                canon_vals = sorted(set().union(*(variants[i]["values_set"] for i in group)))
            elif strategy == "no_merge":
                canon_vals = sorted(variants[group[0]]["values_set"])
            else:
                canon_vals = sorted(set().union(*(variants[i]["values_set"] for i in group)))

            # Gather all item_ids across this group
            group_item_ids: List[str] = []
            for i in group:
                group_item_ids.extend(variants[i]["item_ids"])
            # Dedup while preserving order
            seen: Set[str] = set()
            unique_item_ids: List[str] = []
            for iid in group_item_ids:
                if iid not in seen:
                    seen.add(iid)
                    unique_item_ids.append(iid)

            # Compute noise per group
            for i in group:
                extra = len(canon_vals) - len(variants[i]["values_set"])
                total_noise += extra * variants[i]["item_count"]
                max_noise_per_item = max(max_noise_per_item, extra)

            # Fetch item details (cap at 200 per list for performance)
            item_details: List[Dict[str, Any]] = []
            fetch_ids = unique_item_ids[:200]
            if fetch_ids:
                item_rows = (
                    db.query(models.BomItem)
                    .filter(models.BomItem.item_id.in_(fetch_ids))
                    .all()
                )
                item_map = {it.item_id: it for it in item_rows}
                for iid in fetch_ids:
                    it = item_map.get(iid)
                    if it:
                        item_details.append({
                            "itemId": it.item_id,
                            "description": it.description or "",
                            "category": it.category or "",
                            "priority": it.priority,
                            "productType": it.product_type or "",
                        })

            # Build variant details for this group
            group_variants = []
            for i in group:
                group_variants.append({
                    "comboId": variants[i]["comboId"],
                    "values": sorted(variants[i]["values_set"]),
                    "itemCount": variants[i]["item_count"],
                })

            canonical_lists.append(canon_vals)
            item_assignments.append(unique_item_ids)
            lists_result.append({
                "index": gi,
                "values": canon_vals,
                "itemCount": len(unique_item_ids),
                "items": item_details,
                "totalItemIds": unique_item_ids,
                "variants": group_variants,
            })

        # Upsert the plan
        now = time.time()
        plan = db.query(models.ConsolidationPlan).filter(
            models.ConsolidationPlan.feature_id == feature_id
        ).first()
        if plan:
            plan.strategy = strategy
            plan.status = "completed"
            plan.lists_needed = len(canonical_groups)
            plan.canonical_lists_json = canonical_lists
            plan.item_assignments_json = item_assignments
            plan.details_json = lists_result
            plan.total_noise = total_noise
            plan.max_noise_per_item = max_noise_per_item
            plan.error_message = None
            plan.updated_by = username
            plan.updated_at = now
        else:
            plan = models.ConsolidationPlan(
                feature_id=feature_id,
                strategy=strategy,
                status="completed",
                lists_needed=len(canonical_groups),
                canonical_lists_json=canonical_lists,
                item_assignments_json=item_assignments,
                details_json=lists_result,
                total_noise=total_noise,
                max_noise_per_item=max_noise_per_item,
                created_by=username,
                created_at=now,
            )
            db.add(plan)
        _safe_commit(db)

    except Exception as exc:
        logger.exception("consolidation compute failed for feature_id=%s: %s", feature_id, exc)
        db.rollback()
        try:
            fail_db = SessionLocal()
            plan = fail_db.query(models.ConsolidationPlan).filter(
                models.ConsolidationPlan.feature_id == feature_id
            ).first()
            if plan:
                plan.status = "failed"
                plan.error_message = str(exc)[:500]
                plan.updated_at = time.time()
                fail_db.commit()
            fail_db.close()
        except Exception:
            pass
    finally:
        db.close()


async def _run_consolidation_async(feature_id: str, strategy: str, username: str):
    async with _consolidation_lock:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, _compute_consolidation_plan, feature_id, strategy, username)


@router.post("/feature-combinations/consolidation-plans/compute")
def trigger_consolidation_compute(
    body: Dict[str, Any] = Body(...),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Trigger background computation of a consolidation plan for a single feature."""
    feature_id = body.get("featureId")
    strategy = body.get("strategy", "subset_merge")

    if not feature_id:
        raise HTTPException(status_code=400, detail="featureId is required")
    if strategy not in ("full_union", "subset_merge", "no_merge"):
        raise HTTPException(status_code=400, detail="strategy must be full_union, subset_merge, or no_merge")

    now = time.time()
    # Upsert a "computing" placeholder
    existing = (
        db.query(models.ConsolidationPlan)
        .filter(models.ConsolidationPlan.feature_id == feature_id)
        .first()
    )
    if existing:
        existing.strategy = strategy
        existing.status = "computing"
        existing.error_message = None
        existing.updated_by = current_user.username
        existing.updated_at = now
    else:
        existing = models.ConsolidationPlan(
            feature_id=feature_id,
            strategy=strategy,
            status="computing",
            lists_needed=0,
            canonical_lists_json=[],
            item_assignments_json=[],
            total_noise=0,
            max_noise_per_item=0,
            created_by=current_user.username,
            created_at=now,
        )
        db.add(existing)
    db.commit()
    db.refresh(existing)

    background_tasks.add_task(_run_consolidation_async, feature_id, strategy, current_user.username)

    return {
        "featureId": feature_id,
        "strategy": strategy,
        "status": "computing",
    }


@router.get("/feature-combinations/consolidation-plans/by-feature")
def get_consolidation_plan_by_feature(
    feature_id: str = Query(..., alias="featureId"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return the saved consolidation plan for a feature_id, including full details."""
    plan = (
        db.query(models.ConsolidationPlan)
        .filter(models.ConsolidationPlan.feature_id == feature_id)
        .first()
    )
    if not plan:
        raise HTTPException(status_code=404, detail="no plan found for this feature")

    return {
        "featureId": plan.feature_id,
        "strategy": plan.strategy,
        "status": plan.status,
        "listsNeeded": plan.lists_needed,
        "totalNoise": plan.total_noise,
        "maxNoisePerItem": plan.max_noise_per_item,
        "applied": plan.status == "completed",
        "appliedAt": plan.updated_at or plan.created_at,
        "appliedBy": plan.updated_by or plan.created_by,
        "errorMessage": plan.error_message,
        "lists": plan.details_json or [],
    }


@router.get("/feature-combinations/consolidation-plans")
def list_consolidation_plans(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """List all saved consolidation plans."""
    plans = db.query(models.ConsolidationPlan).order_by(models.ConsolidationPlan.feature_id).all()
    return {
        "plans": [
            {
                "id": p.id,
                "featureId": p.feature_id,
                "strategy": p.strategy,
                "status": p.status,
                "listsNeeded": p.lists_needed,
                "totalNoise": p.total_noise,
                "maxNoisePerItem": p.max_noise_per_item,
                "createdBy": p.created_by,
                "createdAt": p.created_at,
                "updatedBy": p.updated_by,
                "updatedAt": p.updated_at,
            }
            for p in plans
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
            "valueStatus": row.value_status,
            "signedOnByUserId": row.signed_on_by_user_id,
            "signedOnByUsername": row.signed_on_by_username,
            "signedOnAt": row.signed_on_at,
            "updatedAt": row.updated_at,
            "allGlobalTargets": targets,
            "candidateAttributeIds": row.candidate_attribute_ids_json,
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
    candidates_by_feature = _build_all_candidates_by_feature(db.query(models.GlobalMapping).all())

    # Build exclusion indexes
    _gm_status_by_feature: Dict[str, str] = {}
    _gm_ignored_values_by_feature: Dict[str, Set[str]] = {}
    for gm in db.query(models.GlobalMapping).all():
        gm_status = (getattr(gm, "status", "active") or "active").strip().lower()
        gm_ignored = set(getattr(gm, "ignored_values", []) or [])
        for fid in (getattr(gm, "legacy_feature_ids", []) or []):
            nfid = str(fid or "").strip()
            if not nfid:
                continue
            if gm_status != "active":
                _gm_status_by_feature[nfid] = gm_status
            if gm_ignored:
                _gm_ignored_values_by_feature.setdefault(nfid, set()).update(gm_ignored)

    features = db.query(models.BomFeature).filter(models.BomFeature.item_id == bom_item.id).all()

    signed_ts = time.time()
    generated = 0
    for feat in features:
        feat_feature_id = str(getattr(feat, "feature_id", "") or "").strip()
        mapping = mapping_by_feature.get(feat_feature_id)
        candidates = candidates_by_feature.get(feat_feature_id, [])
        if len(candidates) > 1:
            target_attr = ""
            candidates_json = candidates
        elif len(candidates) == 1:
            target_attr = candidates[0]
            candidates_json = candidates
        else:
            target_attr = ""
            candidates_json = None
        attr_type = (getattr(mapping, "attribute_type", "") or "").strip() if mapping else ""
        feat_condition = (getattr(feat, "condition", "") or "").strip() or None
        feat_formula = (getattr(feat, "formula", "") or "").strip() or None
        value_mappings = getattr(mapping, "value_mappings", {}) if mapping else {}

        feature_gm_status = _gm_status_by_feature.get(feat_feature_id)
        feature_ignored_values = _gm_ignored_values_by_feature.get(feat_feature_id, set())

        raw_values = getattr(feat, "values", []) or []
        till_dates: Dict[str, str] = {}
        if isinstance(raw_values, dict):
            values = [str(v) for v in (raw_values.get("values") or [])]
            till_dates = raw_values.get("valueTillDates", {}) or {}
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
                value_status=feature_gm_status,
                signed_on_by_user_id=user_id,
                signed_on_by_username=username,
                signed_on_at=signed_ts,
                updated_at=time.time(),
                version=1,
                created_by=user_id,
                modified_by=user_id,
                modified_at=time.time(),
                candidate_attribute_ids_json=candidates_json,
            ))
            generated += 1
        else:
            for legacy_value in values:
                val_status = None
                if feature_gm_status:
                    val_status = feature_gm_status
                elif legacy_value in feature_ignored_values:
                    val_status = "ignored"
                else:
                    td_str = till_dates.get(legacy_value)
                    if td_str and str(td_str).strip():
                        val_status = "discontinued"

                if val_status:
                    db.add(models.WorkspaceMapping(
                        legacy_item_id=item_id,
                        legacy_feature_id=feat_feature_id,
                        legacy_value=str(legacy_value),
                        new_attribute_id=target_attr,
                        new_value="NOT REQUIRED",
                        attribute_type=attr_type,
                        condition=feat_condition,
                        formula=feat_formula,
                        mapped_from="global",
                        value_status=val_status,
                        signed_on_by_user_id=user_id,
                        signed_on_by_username=username,
                        signed_on_at=signed_ts,
                        updated_at=time.time(),
                        version=1,
                        created_by=user_id,
                        modified_by=user_id,
                        modified_at=time.time(),
                        candidate_attribute_ids_json=candidates_json,
                    ))
                else:
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
                        value_status=None,
                        signed_on_by_user_id=user_id,
                        signed_on_by_username=username,
                        signed_on_at=signed_ts,
                        updated_at=time.time(),
                        version=1,
                        created_by=user_id,
                        modified_by=user_id,
                        modified_at=time.time(),
                        candidate_attribute_ids_json=candidates_json,
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
        new_attribute_id = str(row.get("newAttributeId") or row.get("new_attribute_id") or "")
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
            # attribute_type is tied to the legacy feature and set during
            # generation — never overwrite it on user edits.
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
                "status": getattr(m, "status", "active") or "active",
                "ignoredValues": getattr(m, "ignored_values", []) or [],
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
            # Rows with value_status set are resolved (excluded) — not empty
            (WM.value_status.isnot(None), 0),
            (func.trim(func.coalesce(WM.new_value, literal_column("''"))) == literal_column("''"), 1),
            else_=0,
        )
    ).label("empty_count")

    status_excluded_count = func.sum(
        case(
            (WM.value_status.isnot(None), 1),
            else_=0,
        )
    ).label("status_excluded_count")

    feature_q = (
        db.query(
            WM.legacy_item_id,
            WM.legacy_feature_id,
            func.max(WM.new_attribute_id).label("new_attribute_id"),
            func.max(WM.attribute_type).label("attribute_type"),
            has_empty_val,
            status_excluded_count,
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
            # A feature is mapped when all active (non-excluded) values have a new_value
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
    excludeOtherLocks: bool = False,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return only the total count of BOM items matching the filter — no feature data."""
    search = _validate_search(search)
    query = db.query(func.count(models.BomItem.id))

    # For non-admin users, exclude items locked by other users
    if excludeOtherLocks:
        current_user_id = f"USR-{current_user.id}"
        other_locked_ids = [
            row[0]
            for row in db.query(models.ItemLock.item_id)
            .filter(models.ItemLock.user_id != current_user_id)
            .all()
        ]
        if other_locked_ids:
            query = query.filter(~models.BomItem.item_id.in_(other_locked_ids))

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
    # Non-admin (or admin with specific userId) —
    # Show items signed-on by this user + items not locked by anyone
    # (i.e. hide items locked by OTHER users)
    # ------------------------------------------------------------------
    target_user_id = userId if (is_admin and userId) else current_user_id

    # IDs locked by OTHER users (not the target user)
    other_locked_ids = [
        row[0]
        for row in db.query(models.ItemLock.item_id)
        .filter(models.ItemLock.user_id != target_user_id)
        .all()
    ]

    # Signed-on count for the target user (before filters)
    signed_on_count = (
        db.query(func.count(models.ItemLock.item_id))
        .filter(models.ItemLock.user_id == target_user_id)
        .scalar()
        or 0
    )

    # Base query: all items EXCEPT those locked by other users
    query = db.query(models.BomItem).options(selectinload(models.BomItem.features))
    if other_locked_ids:
        query = query.filter(~models.BomItem.item_id.in_(other_locked_ids))

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

    # Sort: signed-on items first, then alphabetical
    my_locked_ids = [
        row[0]
        for row in db.query(models.ItemLock.item_id)
        .filter(models.ItemLock.user_id == target_user_id)
        .all()
    ]
    if my_locked_ids:
        query = query.order_by(
            # 0 for signed-on items (sort first), 1 for others
            case((models.BomItem.item_id.in_(my_locked_ids), 0), else_=1),
            models.BomItem.item_id,
        )
    else:
        query = query.order_by(models.BomItem.item_id)

    bom_items = query.offset(offset).limit(limit).all()

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
                    value_till_dates = feat.get("valueTillDates") or {}

                    if value_descriptions or value_till_dates:
                        composite_values: Any = {
                            "values": raw_values,
                            "valueDescriptions": value_descriptions,
                            "valueTillDates": value_till_dates,
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
                        "status": str(m.get("status") or "active").strip().lower(),
                        "ignored_values": list(m.get("ignoredValues") or []),
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
                            status=row.get("status") or "active",
                            ignored_values=row.get("ignored_values") or [],
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
                    existing_row.status = row.get("status") or "active"
                    existing_row.ignored_values = row.get("ignored_values") or []
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
            if user_lock_count >= 20:
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
            SUM(CASE WHEN wm.new_value IS NOT NULL AND wm.new_value != '' THEN 1 ELSE 0 END) AS mapped_values,
            SUM(CASE WHEN wm.value_status IS NOT NULL AND wm.value_status != '' THEN 1 ELSE 0 END) AS status_excluded_values
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
        num_status_excluded = int(row.status_excluded_values)
        is_excluded = bool(included_type_set and attr_type and attr_type not in included_type_set)

        # Effective values = total minus those with a value_status set
        effective_values = num_values - num_status_excluded
        effective_mapped = min(num_mapped, effective_values)

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
        elif new_attr and new_attr != "UNMAPPED" and (effective_values == 0 or effective_mapped >= effective_values):
            stats["mapped"] += 1
            mapped_features += 1

        stats["total_vals"] += effective_values
        total_values += effective_values
        stats["mapped_vals"] += effective_mapped
        mapped_values += effective_mapped

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
def get_item_statuses(
        item_ids: Optional[str] = Query(None, alias="itemIds", description="Comma-separated item IDs to compute statuses for (omit for all)"),
        db: Session = Depends(get_db),
):
        # Use the workspace_mappings table which already holds resolved per-item
        # per-feature per-value rows.  A feature is "mapped" only when every
        # value row has a non-blank new_value.
        #
        # Build included-type filter so we can skip ignored attribute types.
        included_type_set = _get_included_type_set(db)

        # Parse optional item_ids filter
        target_item_ids: Optional[List[str]] = None
        if item_ids:
            target_item_ids = [iid.strip() for iid in item_ids.split(",") if iid.strip()]

        # Initialise BOM items — scoped to requested items if provided
        if target_item_ids:
            item_id_rows = db.query(models.BomItem.item_id).filter(
                models.BomItem.item_id.in_(target_item_ids)
            ).all()
        else:
            item_id_rows = db.query(models.BomItem.item_id).all()
        all_item_ids_list = [row[0] for row in item_id_rows]
        item_stats: Dict[str, Dict[str, int]] = {
                item_id: {"mapped": 0, "not_required": 0, "total": 0}
                for item_id in all_item_ids_list
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
                        # Rows with value_status set are resolved — not empty
                        (WM.value_status.isnot(None), 0),
                        (func.trim(func.coalesce(WM.new_value, literal_column("''"))) == literal_column("''"), 1),
                        else_=0,
                )
        ).label("empty_count")

        base_q = db.query(
                WM.legacy_item_id,
                WM.legacy_feature_id,
                func.max(WM.new_attribute_id).label("new_attribute_id"),
                func.max(WM.attribute_type).label("attribute_type"),
                has_empty_val,
        )
        # When item_ids are specified, filter the heavy query to just those items
        if target_item_ids:
            base_q = base_q.filter(WM.legacy_item_id.in_(target_item_ids))

        feature_q = base_q.group_by(WM.legacy_item_id, WM.legacy_feature_id).all()

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
                    "status": getattr(m, "status", "active") or "active",
                    "ignoredValues": getattr(m, "ignored_values", []) or [],
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
            "status": getattr(m, "status", "active") or "active",
            "ignoredValues": getattr(m, "ignored_values", []) or [],
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
    gm_status = str(payload.get("status") or "active").strip().lower()
    gm_ignored_values = list(payload.get("ignoredValues") or [])
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
            status=gm_status,
            ignored_values=gm_ignored_values,
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
        ) or (getattr(row, "status", "active") or "active") != gm_status or list(getattr(row, "ignored_values", []) or []) != gm_ignored_values:
            existing_version = int(getattr(row, "version", 1) or 1)
            row.legacy_feature_ids = legacy_feature_ids
            row.new_attribute_id = new_attribute_id
            row.attribute_type = attribute_type
            row.value_mappings = value_mappings
            row.status = gm_status
            row.ignored_values = gm_ignored_values
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
            "status": getattr(row, "status", "active") or "active",
            "ignoredValues": getattr(row, "ignored_values", []) or [],
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


# ---------------------------------------------------------------------------
# Attribute-combination analysis (dedicated job + summary table)
# ---------------------------------------------------------------------------

_attribute_combination_lock = asyncio.Lock()


def _run_attribute_combination_job(job_id: int):
    """Synchronous worker: scan BomItem+BomFeature, group by sorted feature_id set, count items.

    When the job has ``selected_attribute_types`` set, only features whose
    global-mapping attribute_type is in the selected set are included in the
    fingerprint.  Features that don't match are simply omitted from the
    feature-id set (they are *not* used for grouping).
    """
    db = SessionLocal()

    def _safe_commit(session, max_retries: int = 5):
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
        job = db.query(models.AttributeCombinationJob).filter(models.AttributeCombinationJob.id == job_id).first()
        if not job or job.status not in ("queued", "running"):
            return
        job.status = "running"
        job.started_at = time.time()
        job.updated_at = job.started_at
        _safe_commit(db)

        # Read the selected attribute types (if any) from the job row
        selected_attr_types: Optional[Set[str]] = None
        raw_types = getattr(job, "selected_attribute_types", None)
        if raw_types and isinstance(raw_types, list) and len(raw_types) > 0:
            selected_attr_types = {t.strip().lower() for t in raw_types if t and t.strip()}

        scan_db = SessionLocal()

        # Build feature_id -> attribute_type from global mappings
        attr_type_by_feature: Dict[str, str] = {}
        for gm in scan_db.query(models.GlobalMapping).all():
            at = (getattr(gm, "attribute_type", "") or "").strip()
            for fid in (getattr(gm, "legacy_feature_ids", []) or []):
                normalized_fid = str(fid or "").strip()
                if normalized_fid and at:
                    attr_type_by_feature.setdefault(normalized_fid, at)

        # If attribute types were selected, build allowed feature set
        allowed_features: Optional[Set[str]] = None
        if selected_attr_types is not None:
            allowed_features = {
                fid for fid, at in attr_type_by_feature.items()
                if at.lower() in selected_attr_types
            }

        # Build full item metadata maps
        item_meta: Dict[str, Dict[str, Any]] = {}
        for row in scan_db.query(models.BomItem).all():
            item_meta[str(row.item_id)] = {
                "priority": row.priority,
                "category": str(row.category or "").strip(),
                "product_type": str(row.product_type or "").strip(),
            }

        total_items = len(item_meta)
        job.total_items = total_items
        job.updated_at = time.time()
        _safe_commit(db)

        # Build item_pk -> item_id map
        item_id_by_pk: Dict[int, str] = {
            row_id: item_id
            for row_id, item_id in scan_db.query(models.BomItem.id, models.BomItem.item_id).all()
        }

        # Group feature_ids by item_pk (respecting attribute type filter)
        item_features: Dict[str, Set[str]] = {}
        for feat_item_pk, feat_fid in scan_db.query(models.BomFeature.item_id, models.BomFeature.feature_id).all():
            item_id = item_id_by_pk.get(feat_item_pk)
            if not item_id:
                continue
            fid = str(feat_fid or "").strip()
            if not fid:
                continue
            # When attribute type filter is active, skip features not in allowed set
            if allowed_features is not None and fid not in allowed_features:
                continue
            item_features.setdefault(item_id, set()).add(fid)

        scan_db.close()
        scan_db = None

        # Group items by their sorted feature_id set
        combos: Dict[str, Dict[str, Any]] = {}
        processed = 0
        for item_id, feature_set in item_features.items():
            sorted_fids = sorted(feature_set)
            key = "|".join(sorted_fids)
            if key not in combos:
                combos[key] = {
                    "feature_ids": sorted_fids,
                    "item_ids": set(),
                }
            combos[key]["item_ids"].add(item_id)
            processed += 1
            if processed % 500 == 0:
                job.processed_items = processed
                job.updated_at = time.time()
                _safe_commit(db)

        # Handle items with NO features — they form their own "empty" combination
        for item_id in item_meta:
            if item_id not in item_features:
                key = ""
                if key not in combos:
                    combos[key] = {"feature_ids": [], "item_ids": set()}
                combos[key]["item_ids"].add(item_id)

        # Rebuild summary table
        db.query(models.AttributeCombination).delete()
        built_at = time.time()
        rows: List[Dict[str, Any]] = []
        for key, combo in combos.items():
            item_ids_list = sorted(combo["item_ids"])
            priorities = sorted({
                item_meta[iid]["priority"]
                for iid in item_ids_list
                if iid in item_meta and item_meta[iid]["priority"] is not None
            })
            categories = sorted({
                item_meta[iid]["category"]
                for iid in item_ids_list
                if iid in item_meta and item_meta[iid]["category"]
            })
            product_types = sorted({
                item_meta[iid]["product_type"]
                for iid in item_ids_list
                if iid in item_meta and item_meta[iid]["product_type"]
            })
            rows.append({
                "feature_ids_key": key,
                "feature_ids_json": combo["feature_ids"],
                "feature_count": len(combo["feature_ids"]),
                "item_count": len(item_ids_list),
                "item_ids_json": item_ids_list,
                "attribute_types_json": sorted({
                    attr_type_by_feature[fid]
                    for fid in combo["feature_ids"]
                    if fid in attr_type_by_feature and attr_type_by_feature[fid]
                }) or None,
                "priorities_json": priorities or None,
                "categories_json": categories or None,
                "product_types_json": product_types or None,
                "built_at": built_at,
            })
        if rows:
            db.bulk_insert_mappings(models.AttributeCombination, rows)

        job.status = "completed"
        job.processed_items = processed
        job.generated_rows = len(rows)
        job.finished_at = time.time()
        job.updated_at = job.finished_at
        _safe_commit(db)

    except Exception as exc:
        db.rollback()
        logger.exception("attribute combination job=%s failed: %s", job_id, exc)
        fail_db = SessionLocal()
        try:
            failed_job = fail_db.query(models.AttributeCombinationJob).filter(models.AttributeCombinationJob.id == job_id).first()
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


async def _run_attribute_combination_async(job_id: int):
    async with _attribute_combination_lock:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, _run_attribute_combination_job, job_id)


def _start_attribute_combination_job(job_id: int, background_tasks: Optional[BackgroundTasks] = None):
    if background_tasks is not None:
        background_tasks.add_task(_run_attribute_combination_async, job_id)
    else:
        loop = asyncio.get_event_loop()
        loop.create_task(_run_attribute_combination_async(job_id))


@router.post("/attribute-combinations/trigger")
def trigger_attribute_combination_build(
    background_tasks: BackgroundTasks,
    body: dict = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Trigger a background job to rebuild the attribute-combination summary table.

    Optional body JSON: ``{ "attributeTypes": ["engineering", "commercial"] }``
    When provided, only features with matching global-mapping attribute_type
    are used to build the fingerprint.
    """
    active = (
        db.query(models.AttributeCombinationJob)
        .filter(models.AttributeCombinationJob.status.in_(["queued", "running"]))
        .order_by(models.AttributeCombinationJob.updated_at.desc())
        .first()
    )
    if active:
        return {"ok": True, "jobId": int(active.id)}

    selected_types = None
    if body and isinstance(body.get("attributeTypes"), list):
        selected_types = [t.strip() for t in body["attributeTypes"] if isinstance(t, str) and t.strip()]
        if not selected_types:
            selected_types = None

    job = models.AttributeCombinationJob(
        status="queued",
        triggered_by_user_id=f"USR-{current_user.id}",
        triggered_by_username=getattr(current_user, "username", None),
        selected_attribute_types=selected_types,
        total_items=0,
        processed_items=0,
        generated_rows=0,
        started_at=None,
        finished_at=None,
        updated_at=time.time(),
        error_message=None,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    _start_attribute_combination_job(int(job.id), background_tasks=background_tasks)
    return {"ok": True, "jobId": int(job.id)}


@router.get("/attribute-combinations/progress")
def get_attribute_combination_progress(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return the latest attribute-combination job status."""
    active = (
        db.query(models.AttributeCombinationJob)
        .filter(models.AttributeCombinationJob.status.in_(["queued", "running"]))
        .order_by(models.AttributeCombinationJob.updated_at.desc())
        .first()
    )
    job = active
    is_active = True
    if not job:
        is_active = False
        job = db.query(models.AttributeCombinationJob).order_by(models.AttributeCombinationJob.id.desc()).first()
    if not job:
        return {
            "status": "idle", "isActive": False, "progress": 0.0,
            "totalItems": 0, "processedItems": 0, "generatedRows": 0,
            "startedAt": None, "finishedAt": None, "error": None,
        }
    total = int(getattr(job, "total_items", 0) or 0)
    processed = int(getattr(job, "processed_items", 0) or 0)
    progress = (processed / total) if total > 0 else (1.0 if job.status == "completed" else 0.0)
    return {
        "id": job.id,
        "status": job.status,
        "isActive": bool(is_active),
        "progress": float(max(0.0, min(1.0, progress))),
        "totalItems": total,
        "processedItems": processed,
        "generatedRows": int(getattr(job, "generated_rows", 0) or 0),
        "selectedAttributeTypes": getattr(job, "selected_attribute_types", None) or [],
        "startedAt": getattr(job, "started_at", None),
        "finishedAt": getattr(job, "finished_at", None),
        "error": getattr(job, "error_message", None),
    }


@router.get("/attribute-combinations/filters")
def get_attribute_combination_filters(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return distinct filter values for attribute-combination dropdowns."""
    category_set: Set[str] = set()
    product_type_set: Set[str] = set()
    priority_set: Set[int] = set()
    attribute_type_set: Set[str] = set()
    for (cj,) in db.query(models.AttributeCombination.categories_json).filter(
        models.AttributeCombination.categories_json.isnot(None)
    ).all():
        if isinstance(cj, list):
            for c in cj:
                if c:
                    category_set.add(c)
    for (ptj,) in db.query(models.AttributeCombination.product_types_json).filter(
        models.AttributeCombination.product_types_json.isnot(None)
    ).all():
        if isinstance(ptj, list):
            for pt in ptj:
                if pt:
                    product_type_set.add(pt)
    for (pj,) in db.query(models.AttributeCombination.priorities_json).filter(
        models.AttributeCombination.priorities_json.isnot(None)
    ).all():
        if isinstance(pj, list):
            for p in pj:
                if isinstance(p, int):
                    priority_set.add(p)
    for (atj,) in db.query(models.AttributeCombination.attribute_types_json).filter(
        models.AttributeCombination.attribute_types_json.isnot(None)
    ).all():
        if isinstance(atj, list):
            for at in atj:
                if at:
                    attribute_type_set.add(at)
    # Also return all attribute types from global mappings (for the build picker)
    all_global_attr_types: Set[str] = set()
    for (gm_at,) in db.query(models.GlobalMapping.attribute_type).distinct().all():
        at_val = (gm_at or "").strip()
        if at_val:
            all_global_attr_types.add(at_val)
    return {
        "categories": sorted(category_set),
        "productTypes": sorted(product_type_set),
        "priorities": sorted(priority_set),
        "attributeTypes": sorted(attribute_type_set),
        "availableAttributeTypes": sorted(all_global_attr_types),
    }


@router.get("/attribute-combinations/list")
def list_attribute_combinations(
    search: Optional[str] = None,
    category: Optional[str] = None,
    productType: Optional[str] = None,
    attributeType: Optional[str] = None,
    priority: Optional[int] = None,
    minFeatures: Optional[int] = None,
    maxFeatures: Optional[int] = None,
    sortBy: Optional[str] = None,
    sortDir: Optional[str] = None,
    analysisMode: Optional[bool] = None,
    limit: int = Query(50, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Paginated list of attribute-combination summary rows."""
    base = db.query(models.AttributeCombination)

    if search:
        if len(search) > MAX_SEARCH_LENGTH:
            raise HTTPException(status_code=400, detail="search too long")
        like = f"%{search}%"
        base = base.filter(models.AttributeCombination.feature_ids_key.ilike(like))

    if category:
        cats = [c.strip() for c in category.split(",") if c.strip()]
        if cats:
            base = base.filter(
                cast(models.AttributeCombination.categories_json, String).contains(cats[0])
                if len(cats) == 1
                else or_(*[cast(models.AttributeCombination.categories_json, String).contains(c) for c in cats])
            )

    if productType:
        pts = [p.strip() for p in productType.split(",") if p.strip()]
        if pts:
            base = base.filter(
                cast(models.AttributeCombination.product_types_json, String).contains(pts[0])
                if len(pts) == 1
                else or_(*[cast(models.AttributeCombination.product_types_json, String).contains(p) for p in pts])
            )

    if priority is not None:
        base = base.filter(
            models.AttributeCombination.priorities_json.isnot(None),
            cast(models.AttributeCombination.priorities_json, String).contains(str(priority)),
        )

    if attributeType:
        ats = [a.strip() for a in attributeType.split(",") if a.strip()]
        if ats:
            base = base.filter(
                cast(models.AttributeCombination.attribute_types_json, String).contains(ats[0])
                if len(ats) == 1
                else or_(*[cast(models.AttributeCombination.attribute_types_json, String).contains(a) for a in ats])
            )

    if minFeatures is not None:
        base = base.filter(models.AttributeCombination.feature_count >= minFeatures)
    if maxFeatures is not None:
        base = base.filter(models.AttributeCombination.feature_count <= maxFeatures)

    # Analysis mode: compute similar-fingerprint counts and enrich rows
    similar_count_map: Dict[int, int] = {}
    if analysisMode:
        all_combos_raw = db.query(
            models.AttributeCombination.id,
            models.AttributeCombination.feature_ids_json,
            models.AttributeCombination.feature_count,
        ).all()
        combo_sets: Dict[int, Set[str]] = {}
        for cid, fids, _fc in all_combos_raw:
            combo_sets[cid] = set(fids or [])
        for cid, fset in combo_sets.items():
            if not fset:
                continue
            sim_count = 0
            for oid, oset in combo_sets.items():
                if oid == cid or not oset:
                    continue
                overlap = len(fset & oset)
                min_size = min(len(fset), len(oset))
                if min_size > 0 and (overlap / min_size) >= 0.5:
                    sim_count += 1
            similar_count_map[cid] = sim_count
        # Filter to only combos with similar fingerprints > 0
        ids_with_similar = {cid for cid, cnt in similar_count_map.items() if cnt > 0}
        if ids_with_similar:
            base = base.filter(models.AttributeCombination.id.in_(ids_with_similar))
        else:
            return {"items": [], "total": 0}

    total = base.count()

    sort_allowed = {
        "itemCount": models.AttributeCombination.item_count,
        "featureCount": models.AttributeCombination.feature_count,
    }
    sort_col = sort_allowed.get(sortBy) if sortBy else None
    is_desc = (sortDir or "desc").lower() != "asc"

    if analysisMode and sortBy == "similarCount":
        # Sort by similar count (in-memory after fetch)
        rows = base.order_by(models.AttributeCombination.item_count.desc()).all()
        rows.sort(key=lambda r: (-similar_count_map.get(r.id, 0) if is_desc else similar_count_map.get(r.id, 0), -r.item_count))
        rows = rows[offset:offset + limit]
    elif sort_col is not None:
        order = sort_col.desc() if is_desc else sort_col.asc()
        rows = base.order_by(order).offset(offset).limit(limit).all()
    else:
        rows = base.order_by(models.AttributeCombination.item_count.desc()).offset(offset).limit(limit).all()

    # When a priority filter is active, compute filtered item counts
    filtered_item_counts: Dict[int, int] = {}
    if priority is not None and rows:
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
            "featureIdsKey": r.feature_ids_key,
            "featureIds": r.feature_ids_json or [],
            "featureCount": r.feature_count,
            "itemCount": r.item_count,
            "filteredItemCount": filtered_item_counts.get(r.id) if priority is not None else None,
            "attributeTypes": r.attribute_types_json or [],
            "priorities": r.priorities_json or [],
            "categories": r.categories_json or [],
            "productTypes": r.product_types_json or [],
            "builtAt": r.built_at,
            **({"similarCount": similar_count_map.get(r.id, 0)} if analysisMode else {}),
        }
        for r in rows
    ]
    return {"items": items, "total": total}


@router.get("/attribute-combinations/analysis/{combo_id}")
def get_attribute_combination_analysis(
    combo_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Consolidation analysis for an attribute fingerprint.

    Finds similar fingerprints (≥50% attribute overlap) and computes merge options.
    """
    combo = db.query(models.AttributeCombination).filter(models.AttributeCombination.id == combo_id).first()
    if not combo:
        raise HTTPException(status_code=404, detail="combination not found")

    target_set = set(combo.feature_ids_json or [])
    if not target_set:
        raise HTTPException(status_code=400, detail="empty fingerprint")

    # Find all other fingerprints with ≥50% overlap
    all_combos = db.query(models.AttributeCombination).filter(
        models.AttributeCombination.id != combo_id,
        models.AttributeCombination.feature_count > 0,
    ).all()

    similar: list = []
    all_union = set(target_set)
    total_items = combo.item_count
    fingerprint_sets: list = [(combo_id, target_set, combo.item_count)]

    for other in all_combos:
        other_set = set(other.feature_ids_json or [])
        if not other_set:
            continue
        overlap = len(target_set & other_set)
        min_size = min(len(target_set), len(other_set))
        if min_size == 0:
            continue
        overlap_pct = round(100 * overlap / min_size)
        if overlap_pct < 50:
            continue

        common = sorted(target_set & other_set)
        unique = sorted(other_set - target_set)
        if other_set == target_set:
            rel = "identical"
        elif other_set < target_set:
            rel = "subset"
        elif other_set > target_set:
            rel = "superset"
        else:
            rel = "overlap"

        similar.append({
            "comboId": other.id,
            "featureIds": other.feature_ids_json or [],
            "featureCount": other.feature_count,
            "itemCount": other.item_count,
            "relationship": rel,
            "overlapPercent": overlap_pct,
            "commonAttributes": common,
            "uniqueAttributes": unique,
        })
        all_union.update(other_set)
        total_items += other.item_count
        fingerprint_sets.append((other.id, other_set, other.item_count))

    similar.sort(key=lambda x: (-x["overlapPercent"], -x["itemCount"]))
    common_attrs = sorted(set.intersection(*(s for _, s, _ in fingerprint_sets))) if len(fingerprint_sets) > 1 else sorted(target_set)
    union_attrs = sorted(all_union)

    # --- Merge Options ---
    # 1. Full Union: everyone gets the union set of attributes
    full_union_noise = 0
    full_union_max = 0
    for _, fset, ic in fingerprint_sets:
        extra = len(all_union) - len(fset)
        full_union_noise += extra * ic
        full_union_max = max(full_union_max, extra)

    # 2. Subset Merge: merge strict subsets into their supersets
    remaining_idx = list(range(len(fingerprint_sets)))
    canonical_groups: list = []
    while remaining_idx:
        best = max(remaining_idx, key=lambda i: len(fingerprint_sets[i][1]))
        best_set = fingerprint_sets[best][1]
        group = [best]
        new_remaining = []
        for idx in remaining_idx:
            if idx == best:
                continue
            if fingerprint_sets[idx][1] <= best_set:
                group.append(idx)
            else:
                new_remaining.append(idx)
        canonical_groups.append(group)
        remaining_idx = new_remaining

    subset_canonical_lists = []
    subset_noise = 0
    subset_max_noise = 0
    for grp in canonical_groups:
        canon = sorted(set().union(*(fingerprint_sets[i][1] for i in grp)))
        subset_canonical_lists.append(canon)
        for i in grp:
            extra = len(canon) - len(fingerprint_sets[i][1])
            subset_noise += extra * fingerprint_sets[i][2]
            subset_max_noise = max(subset_max_noise, extra)

    # 3. No Merge: keep each fingerprint as-is
    merge_options = [
        {
            "label": "Full Union",
            "canonicalValues": [union_attrs],
            "listsNeeded": 1,
            "totalNoise": full_union_noise,
            "maxNoisePerItem": full_union_max,
        },
        {
            "label": "Subset Merge",
            "canonicalValues": subset_canonical_lists,
            "listsNeeded": len(canonical_groups),
            "totalNoise": subset_noise,
            "maxNoisePerItem": subset_max_noise,
        },
        {
            "label": "No Merge",
            "canonicalValues": [sorted(s) for _, s, _ in fingerprint_sets],
            "listsNeeded": len(fingerprint_sets),
            "totalNoise": 0,
            "maxNoisePerItem": 0,
        },
    ]

    return {
        "comboId": combo_id,
        "fingerprint": sorted(target_set),
        "featureCount": len(target_set),
        "totalSimilar": len(similar),
        "totalItems": total_items,
        "commonAttributes": common_attrs,
        "unionAttributes": union_attrs,
        "similarCombos": similar[:50],
        "mergeOptions": merge_options,
    }


@router.get("/attribute-combinations/{combo_id}/items")
def get_attribute_combination_items(
    combo_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return the BOM items in the selected attribute combination."""
    combo = db.query(models.AttributeCombination).filter(models.AttributeCombination.id == combo_id).first()
    if not combo:
        raise HTTPException(status_code=404, detail="combination not found")

    item_ids = combo.item_ids_json or []
    if not item_ids:
        return {"items": []}

    bom_items = (
        db.query(models.BomItem)
        .filter(models.BomItem.item_id.in_(item_ids))
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
            }
            for itm in bom_items
        ]
    }


# ---------------------------------------------------------------------------
# Migration manifest (live queries — no build step needed)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Shared helpers for live manifest queries
# ---------------------------------------------------------------------------


def _build_ac_item_count_map(db: Session) -> Dict[str, int]:
    """Build item_id → item_count from the pre-computed attribute_combinations table."""
    result: Dict[str, int] = {}
    for ac in db.query(models.AttributeCombination).all():
        count = ac.item_count or 1
        for iid in (ac.item_ids_json or []):
            result[iid] = count
    return result


def _build_feature_target_map(db: Session) -> Dict[str, Dict[str, Any]]:
    """Build feature_id → {attr, attrType, valueMappings, ignoredValues} from GlobalMapping."""
    result: Dict[str, Dict[str, Any]] = {}
    for gm in db.query(models.GlobalMapping).all():
        gm_status = (getattr(gm, "status", "active") or "active").strip().lower()
        if gm_status in ("deprecated", "ignored"):
            continue
        attr = str(getattr(gm, "new_attribute_id", "") or "").strip()
        attr_type = str(getattr(gm, "attribute_type", "") or "").strip()
        value_mappings = dict(getattr(gm, "value_mappings", None) or {})
        ignored_values = {
            str(v or "").strip()
            for v in (getattr(gm, "ignored_values", None) or [])
            if str(v or "").strip()
        }
        for fid in (getattr(gm, "legacy_feature_ids", None) or []):
            normalized_fid = str(fid or "").strip()
            if not normalized_fid:
                continue
            if normalized_fid not in result:
                result[normalized_fid] = {
                    "attr": attr,
                    "attrType": attr_type,
                    "valueMappings": value_mappings,
                    "ignoredValues": ignored_values,
                }
    return result


def _build_workspace_overrides(db: Session, item_id: Optional[str] = None) -> Dict[tuple, Dict[str, str]]:
    """Build (item_id, feature_id, value) → {attr, value} from WorkspaceMapping."""
    q = db.query(models.WorkspaceMapping)
    if item_id:
        q = q.filter(models.WorkspaceMapping.legacy_item_id == item_id)
    result: Dict[tuple, Dict[str, str]] = {}
    for wm in q.all():
        key = (
            str(wm.legacy_item_id or "").strip(),
            str(wm.legacy_feature_id or "").strip(),
            str(wm.legacy_value or "").strip(),
        )
        if not all(key):
            continue
        result[key] = {
            "attr": str(wm.new_attribute_id or "").strip(),
            "value": str(wm.new_value or "").strip(),
        }
    return result


def _get_completed_consolidation_plans(db: Session) -> Dict[str, Any]:
    """Build feature_id → ConsolidationPlan for completed plans."""
    return {
        str(plan.feature_id).strip(): plan
        for plan in db.query(models.ConsolidationPlan)
        .filter(models.ConsolidationPlan.status == "completed")
        .all()
        if str(plan.feature_id or "").strip()
    }


def _resolve_feature_targets(
    item_id: str,
    feature_id: str,
    values: List[str],
    feature_map: Dict[str, Dict[str, Any]],
    workspace_overrides: Dict[tuple, Dict[str, str]],
) -> Dict[str, Any]:
    """Resolve target attribute/values for a feature — same logic as old manifest build."""
    attrs: List[str] = []
    seen_attrs: Set[str] = set()
    target_values: List[str] = []
    seen_target: Set[str] = set()
    has_mapping = False
    value_pairs: Dict[str, str] = {}  # legacyValue → targetValue

    fm = feature_map.get(feature_id)
    if fm:
        a = fm.get("attr", "")
        if a and a not in seen_attrs:
            seen_attrs.add(a)
            attrs.append(a)

    for raw_value in values:
        lv = str(raw_value or "").strip()
        if not lv:
            continue
        ws = workspace_overrides.get((item_id, feature_id, lv))
        if ws:
            a = ws.get("attr", "")
            if a and a not in seen_attrs:
                seen_attrs.add(a)
                attrs.append(a)
            v = ws.get("value", "")
            value_pairs[lv] = v
            if v and v not in seen_target:
                seen_target.add(v)
                target_values.append(v)
            has_mapping = True
            continue
        if fm:
            if lv in fm.get("ignoredValues", set()):
                value_pairs[lv] = "IGNORED"
                continue
            mapped = fm.get("valueMappings", {}).get(lv)
            if mapped is not None and str(mapped).strip():
                tv = str(mapped).strip()
                value_pairs[lv] = tv
                if tv not in seen_target:
                    seen_target.add(tv)
                    target_values.append(tv)
                has_mapping = True
            else:
                value_pairs[lv] = ""
        else:
            value_pairs[lv] = ""

    if not values and attrs:
        has_mapping = True

    return {
        "attrs": attrs,
        "targetValues": sorted(target_values),
        "hasMapping": has_mapping or bool(attrs),
        "valuePairs": value_pairs,
    }


def _compute_value_merge_noise(
    item_id: str,
    feature_id: str,
    original_values: List[str],
    plans: Dict[str, Any],
) -> Optional[List[str]]:
    """Return noise values (canonical - original) if item is in a consolidation plan."""
    plan = plans.get(feature_id)
    if not plan:
        return None
    canonical_lists = plan.canonical_lists_json or []
    item_assignments = plan.item_assignments_json or []
    original_set = set(original_values)

    for idx, assigned_items in enumerate(item_assignments):
        if item_id in (assigned_items or []):
            if idx < len(canonical_lists):
                canonical = set(canonical_lists[idx] or [])
                noise = sorted(canonical - original_set)
                return noise if noise else None
    return None



# ---------------------------------------------------------------------------
# Migration manifest endpoints (live queries against AC, FC, plans)
# ---------------------------------------------------------------------------


_manifest_filters_cache: Optional[Dict[str, Any]] = None
_manifest_filters_cache_ts: float = 0.0
_MANIFEST_FILTERS_TTL = 30.0  # seconds


@router.get("/migration-manifest/ready")
def check_migration_manifest_ready(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Check whether prerequisite tables are built."""
    ac_count = db.query(func.count(models.AttributeCombination.id)).scalar() or 0
    fc_count = db.query(func.count(models.FeatureCombination.id)).scalar() or 0
    return {
        "ready": ac_count > 0 and fc_count > 0,
        "attributeCombinations": ac_count,
        "featureCombinations": fc_count,
    }


@router.get("/migration-manifest/filters")
def get_migration_manifest_filters(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return distinct filter values from live BOM + mapping data."""
    global _manifest_filters_cache, _manifest_filters_cache_ts
    now = time.time()
    if _manifest_filters_cache is not None and now - _manifest_filters_cache_ts < _MANIFEST_FILTERS_TTL:
        return _manifest_filters_cache

    B = models.BomItem
    categories = sorted({
        str(r[0]).strip()
        for r in db.query(B.category).filter(B.category.isnot(None), B.category != "").distinct().all()
    })
    product_types = sorted({
        str(r[0]).strip()
        for r in db.query(B.product_type).filter(B.product_type.isnot(None), B.product_type != "").distinct().all()
    })
    priorities = sorted({
        r[0] for r in db.query(B.priority).filter(B.priority.isnot(None)).distinct().all()
    })
    attribute_types = sorted({
        str(r[0]).strip()
        for r in db.query(models.GlobalMapping.attribute_type)
        .filter(models.GlobalMapping.attribute_type.isnot(None), models.GlobalMapping.attribute_type != "")
        .filter(models.GlobalMapping.status != "deprecated", models.GlobalMapping.status != "ignored")
        .distinct().all()
    })
    target_attributes = sorted({
        str(r[0]).strip()
        for r in db.query(models.GlobalMapping.new_attribute_id)
        .filter(models.GlobalMapping.new_attribute_id.isnot(None), models.GlobalMapping.new_attribute_id != "")
        .filter(models.GlobalMapping.status != "deprecated", models.GlobalMapping.status != "ignored")
        .distinct().all()
    })
    result = {
        "categories": categories,
        "productTypes": product_types,
        "priorities": priorities,
        "sources": ["original", "value_merge"],
        "noiseTypes": ["missing_value"],
        "attributeTypes": attribute_types,
        "targetAttributes": target_attributes,
    }
    _manifest_filters_cache = result
    _manifest_filters_cache_ts = time.time()
    return result


@router.get("/migration-manifest/item-summaries")
def list_migration_manifest_item_summaries(
    search: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    product_type: Optional[str] = Query(None, alias="productType"),
    priority: Optional[int] = Query(None),
    attribute_type: Optional[str] = Query(None, alias="attributeType"),
    source: Optional[str] = Query(None),
    has_noise: Optional[bool] = Query(None, alias="hasNoise"),
    has_mapping: Optional[bool] = Query(None, alias="hasMapping"),
    item_ids: Optional[str] = Query(None, alias="itemIds"),
    sort_by: str = Query("itemPriority", alias="sortBy"),
    sort_dir: str = Query("desc", alias="sortDir"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return one row per BOM item with pre-computed counts from manifest_item_stats.

    Stats are computed during the batch job — this endpoint is a fast read.
    """
    search = _validate_search(search)

    # ---- Build WHERE clauses ----
    wheres: list[str] = []
    params: dict = {}
    if category:
        wheres.append("b.category = :category")
        params["category"] = category
    if product_type:
        wheres.append("b.product_type = :product_type")
        params["product_type"] = product_type
    if priority is not None:
        wheres.append("b.priority = :priority")
        params["priority"] = priority
    if search:
        wheres.append("(b.item_id LIKE :search OR b.description LIKE :search)")
        params["search"] = f"%{search.strip()}%"
    if attribute_type:
        wheres.append("""b.item_id IN (
            SELECT DISTINCT legacy_item_id FROM merged_workspace_mappings
            WHERE LOWER(TRIM(attribute_type)) = LOWER(TRIM(:attr_type_filter))
        )""")
        params["attr_type_filter"] = attribute_type
    if item_ids:
        import re as _re
        ids = [x.strip() for x in item_ids.split(",") if x.strip()]
        ids = [x for x in ids if _re.fullmatch(r"[A-Za-z0-9_.\-]+", x)]
        if ids:
            placeholders = ", ".join(f":_iid{i}" for i in range(len(ids)))
            wheres.append(f"b.item_id IN ({placeholders})")
            for i, v in enumerate(ids):
                params[f"_iid{i}"] = v
        else:
            wheres.append("1=0")

    where_sql = (" AND " + " AND ".join(wheres)) if wheres else ""

    # ---- Main query: bom_items LEFT JOIN manifest_item_stats ----
    base_sql = f"""
        SELECT
            b.item_id, b.description, b.category, b.product_type, b.priority,
            COALESCE(s.attr_count, 0),
            COALESCE(s.mapped_count, 0),
            COALESCE(s.combo_item_count, 1),
            COALESCE(s.shared_vl_count, 0),
            COALESCE(s.legacy_combo_item_count, 1),
            COALESCE(s.legacy_shared_vl_count, 0),
            COALESCE(s.footprint_attr_list, ''),
            COALESCE(s.footprint_legacy_feature_list, ''),
            COALESCE(s.footprint_value_list, ''),
            COALESCE(s.footprint_legacy_value_list, '')
        FROM bom_items b
        LEFT JOIN manifest_item_stats s ON s.item_id = b.item_id
        WHERE 1=1 {where_sql}
    """

    # ---- Sort ----
    sort_map = {
        "itemId": "b.item_id",
        "itemPriority": "b.priority",
        "totalRows": "COALESCE(s.attr_count, 0)",
        "comboItemCount": "COALESCE(s.combo_item_count, 1)",
        "mappedCount": "COALESCE(s.mapped_count, 0)",
        "sharedValuelistCount": "COALESCE(s.shared_vl_count, 0)",
        "legacyComboItemCount": "COALESCE(s.legacy_combo_item_count, 1)",
        "legacySharedVlCount": "COALESCE(s.legacy_shared_vl_count, 0)",
    }
    sort_col = sort_map.get(sort_by, "b.priority")
    direction = "ASC" if sort_dir == "asc" else "DESC"

    count_sql = f"SELECT COUNT(*) FROM bom_items b LEFT JOIN manifest_item_stats s ON s.item_id = b.item_id WHERE 1=1 {where_sql}"
    total = db.execute(sa_text(count_sql), params).scalar() or 0

    paginated_sql = f"{base_sql} ORDER BY {sort_col} {direction}, b.item_id ASC LIMIT :lim OFFSET :off"
    params["lim"] = limit
    params["off"] = offset
    rows = db.execute(sa_text(paginated_sql), params).fetchall()

    result_items = []
    for r in rows:
        iid, desc, cat, pt, pri, ac, mc, combo, svl, lcombo, lsvl, fp_al, fp_lfl, fp_vl, fp_lvl = r
        fp_attr_count = len(fp_al.split('|')) if fp_al else 0
        fp_legacy_feat_count = len(fp_lfl.split('|')) if fp_lfl else 0
        fp_value_count = len(fp_vl.split('|')) if fp_vl else 0
        fp_legacy_value_count = len(fp_lvl.split('|')) if fp_lvl else 0
        result_items.append({
            "itemId": iid,
            "itemDescription": desc or "",
            "itemCategory": cat or "",
            "itemProductType": pt or "",
            "itemPriority": pri,
            "totalRows": ac,
            "comboItemCount": combo,
            "valueMergeCount": 0,
            "mappedCount": mc,
            "noiseCount": 0,
            "sharedValuelistCount": svl,
            "legacyComboItemCount": lcombo,
            "legacySharedVlCount": lsvl,
            "fpAttrMapped": fp_attr_count,
            "fpAttrTotal": fp_legacy_feat_count,
            "fpValueMapped": fp_value_count,
            "fpValueTotal": fp_legacy_value_count,
        })

    return {"items": result_items, "total": total}


@router.get("/migration-manifest/items/{item_id}/attributes")
def get_migration_manifest_item_attributes(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return attribute-level merge suggestions from live BOM + mapping + plan data."""
    item = db.query(models.BomItem).filter(models.BomItem.item_id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="item not found")

    feature_map = _build_feature_target_map(db)
    workspace_overrides = _build_workspace_overrides(db, item_id)
    plans = _get_completed_consolidation_plans(db)

    # Check which (item, feature) pairs are already saved in merged workspace mappings
    saved_keys: Set[str] = set()
    for r in db.query(models.MergedWorkspaceMapping.legacy_feature_id).filter(
        models.MergedWorkspaceMapping.legacy_item_id == item_id
    ).all():
        if r[0]:
            saved_keys.add(str(r[0]).strip())

    features = (
        db.query(models.BomFeature)
        .filter(models.BomFeature.item_id == item.id)
        .order_by(models.BomFeature.feature_id.asc())
        .all()
    )

    attrs: dict = {}
    for feat in features:
        fid = str(feat.feature_id or "").strip()
        if not fid:
            continue
        normalized = _normalize_feature_values(getattr(feat, "values", None))
        resolved = _resolve_feature_targets(item_id, fid, normalized, feature_map, workspace_overrides)
        noise = _compute_value_merge_noise(item_id, fid, normalized, plans)

        attr_key = "; ".join(resolved["attrs"]) if resolved["attrs"] else fid
        fm = feature_map.get(fid)
        attr_type = fm.get("attrType", "") if fm else ""

        is_saved = fid in saved_keys

        # Build "original" row
        entry_original = {
            "id": 0,
            "itemId": item_id,
            "itemDescription": item.description or "",
            "itemCategory": item.category or "",
            "itemProductType": item.product_type or "",
            "itemPriority": item.priority,
            "legacyFeatureId": fid,
            "targetAttributeId": attr_key if resolved["attrs"] else "",
            "attributeType": attr_type,
            "source": "original",
            "isNoise": False,
            "noiseType": "",
            "originalValues": normalized,
            "targetValues": resolved["targetValues"],
            "noiseValues": [],
            "hasMapping": resolved["hasMapping"],
            "isAccepted": is_saved,
            "acceptedAt": None,
            "acceptedBy": None,
            "comboItemCount": 1,
            "builtAt": None,
            "valueMappings": resolved.get("valuePairs", {}),
        }

        if attr_key not in attrs:
            attrs[attr_key] = {
                "targetAttributeId": attr_key if resolved["attrs"] else "",
                "attributeType": attr_type,
                "features": [],
                "hasAttrMerge": False,
                "hasValueMerge": False,
            }
        attrs[attr_key]["features"].append(entry_original)

        # Build "value_merge" row if noise exists
        if noise:
            entry_vm = dict(entry_original)
            entry_vm["source"] = "value_merge"
            entry_vm["isNoise"] = True
            entry_vm["noiseType"] = "missing_value"
            entry_vm["noiseValues"] = noise
            attrs[attr_key]["features"].append(entry_vm)
            attrs[attr_key]["hasValueMerge"] = True

    return {"attributes": list(attrs.values())}


@router.get("/migration-manifest/items/{item_id}/attributes/{target_attribute_id}/values")
def get_migration_manifest_value_merge_detail(
    item_id: str,
    target_attribute_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return value-level merge detail from live BOM + mapping + plan data."""
    item = db.query(models.BomItem).filter(models.BomItem.item_id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="item not found")

    feature_map = _build_feature_target_map(db)
    workspace_overrides = _build_workspace_overrides(db, item_id)
    plans = _get_completed_consolidation_plans(db)

    # Find which features map to this target_attribute_id
    features = (
        db.query(models.BomFeature)
        .filter(models.BomFeature.item_id == item.id)
        .order_by(models.BomFeature.feature_id.asc())
        .all()
    )

    entries: list = []
    all_orig: list = []
    all_target: list = []
    all_noise: list = []
    seen_orig: set = set()
    seen_target: set = set()
    seen_noise: set = set()

    for feat in features:
        fid = str(feat.feature_id or "").strip()
        if not fid:
            continue
        normalized = _normalize_feature_values(getattr(feat, "values", None))
        resolved = _resolve_feature_targets(item_id, fid, normalized, feature_map, workspace_overrides)
        attr_key = "; ".join(resolved["attrs"]) if resolved["attrs"] else fid

        if attr_key != target_attribute_id and (not resolved["attrs"] and fid != target_attribute_id):
            continue

        fm = feature_map.get(fid)
        attr_type = fm.get("attrType", "") if fm else ""
        noise = _compute_value_merge_noise(item_id, fid, normalized, plans)

        entry = {
            "id": 0,
            "itemId": item_id,
            "itemDescription": item.description or "",
            "itemCategory": item.category or "",
            "itemProductType": item.product_type or "",
            "itemPriority": item.priority,
            "legacyFeatureId": fid,
            "targetAttributeId": target_attribute_id,
            "attributeType": attr_type,
            "source": "original",
            "isNoise": False,
            "noiseType": "",
            "originalValues": normalized,
            "targetValues": resolved["targetValues"],
            "noiseValues": [],
            "hasMapping": resolved["hasMapping"],
            "isAccepted": False,
            "acceptedAt": None,
            "acceptedBy": None,
            "comboItemCount": 1,
            "builtAt": None,
        }
        entries.append(entry)

        for v in normalized:
            if v not in seen_orig:
                seen_orig.add(v)
                all_orig.append(v)
        for v in resolved["targetValues"]:
            if v not in seen_target:
                seen_target.add(v)
                all_target.append(v)

        if noise:
            vm_entry = dict(entry)
            vm_entry["source"] = "value_merge"
            vm_entry["isNoise"] = True
            vm_entry["noiseType"] = "missing_value"
            vm_entry["noiseValues"] = noise
            entries.append(vm_entry)
            for v in noise:
                if v not in seen_noise:
                    seen_noise.add(v)
                    all_noise.append(v)

    return {
        "itemId": item_id,
        "targetAttributeId": target_attribute_id,
        "entries": entries,
        "originalValues": all_orig,
        "targetValues": all_target,
        "noiseValues": all_noise,
    }


@router.post("/migration-manifest/save-to-workspace")
def save_manifest_to_workspace(
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Compute merge values live and upsert into merged_workspace_mappings."""
    item_id = str(payload.get("itemId") or "").strip()
    target_attribute_id = str(payload.get("targetAttributeId") or "").strip()
    if not item_id:
        raise HTTPException(status_code=400, detail="itemId is required")
    if not target_attribute_id:
        raise HTTPException(status_code=400, detail="targetAttributeId is required")

    item = db.query(models.BomItem).filter(models.BomItem.item_id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="item not found")

    feature_map = _build_feature_target_map(db)
    plans = _get_completed_consolidation_plans(db)

    # Find all items sharing the same attribute fingerprint (combo siblings)
    combo_item_ids: List[str] = [item_id]
    for ac in db.query(models.AttributeCombination).all():
        if item_id in (ac.item_ids_json or []):
            combo_item_ids = [
                iid for iid in (ac.item_ids_json or [])
                if isinstance(iid, str) and iid.strip()
            ]
            break

    now_ts = time.time()
    username = getattr(current_user, "username", None)
    user_id = str(getattr(current_user, "id", ""))
    created_count = 0
    updated_count = 0

    for cur_item_id in combo_item_ids:
        cur_item = db.query(models.BomItem).filter(models.BomItem.item_id == cur_item_id).first()
        if not cur_item:
            continue

        workspace_overrides = _build_workspace_overrides(db, cur_item_id)
        features = (
            db.query(models.BomFeature)
            .filter(models.BomFeature.item_id == cur_item.id)
            .order_by(models.BomFeature.feature_id.asc())
            .all()
        )

        for feat in features:
            fid = str(feat.feature_id or "").strip()
            if not fid:
                continue
            normalized = _normalize_feature_values(getattr(feat, "values", None))
            resolved = _resolve_feature_targets(cur_item_id, fid, normalized, feature_map, workspace_overrides)
            attr_key = "; ".join(resolved["attrs"]) if resolved["attrs"] else ""

            if attr_key != target_attribute_id:
                continue

            fm = feature_map.get(fid)
            attr_type = fm.get("attrType", "") if fm else ""

            # Build (legacy_value, new_value) pairs from resolved value mappings
            all_pairs: List[tuple] = []
            for lv, tv in resolved.get("valuePairs", {}).items():
                if tv == "IGNORED":
                    continue
                all_pairs.append((lv, tv or ""))

            # Noise values: resolve through global mapping value_mappings
            noise = _compute_value_merge_noise(cur_item_id, fid, normalized, plans)
            if noise:
                vm = fm.get("valueMappings", {}) if fm else {}
                for noise_val in noise:
                    mapped = str(vm.get(noise_val, "") or "").strip() or noise_val
                    all_pairs.append((noise_val, mapped))

            if not all_pairs:
                all_pairs = [("", "")]

            for lv, tv in all_pairs:
                existing = (
                    db.query(models.MergedWorkspaceMapping)
                    .filter(
                        models.MergedWorkspaceMapping.legacy_item_id == cur_item_id,
                        models.MergedWorkspaceMapping.legacy_feature_id == fid,
                        models.MergedWorkspaceMapping.legacy_value == lv,
                    )
                    .first()
                )
                if existing:
                    existing.new_attribute_id = target_attribute_id
                    existing.new_value = tv
                    existing.attribute_type = attr_type
                    existing.mapped_from = "manifest"
                    existing.modified_by = username
                    existing.modified_at = now_ts
                    existing.updated_at = now_ts
                    existing.version = (existing.version or 1) + 1
                    updated_count += 1
                else:
                    new_row = models.MergedWorkspaceMapping(
                        legacy_item_id=cur_item_id,
                        legacy_feature_id=fid,
                        legacy_value=lv,
                        new_attribute_id=target_attribute_id,
                        new_value=tv,
                        attribute_type=attr_type,
                        mapped_from="manifest",
                        signed_on_by_user_id=user_id,
                        signed_on_by_username=username,
                        signed_on_at=now_ts,
                        updated_at=now_ts,
                        created_by=username,
                    )
                    db.add(new_row)
                    created_count += 1

    db.commit()
    return {
        "ok": True,
        "mergedMappingsCreated": created_count,
        "mergedMappingsUpdated": updated_count,
        "itemsUpdated": len(combo_item_ids),
        "savedAt": now_ts,
        "savedBy": username,
    }


@router.get("/merged-workspace-mappings/{item_id}")
def get_merged_workspace_mappings(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return all merged workspace mapping rows for a given item.

    Used by the toggle view to compare old workspace mappings with new merged ones.
    """
    rows = (
        db.query(models.MergedWorkspaceMapping)
        .filter(models.MergedWorkspaceMapping.legacy_item_id == item_id)
        .order_by(
            models.MergedWorkspaceMapping.legacy_feature_id.asc(),
            models.MergedWorkspaceMapping.legacy_value.asc(),
        )
        .all()
    )
    return {
        "items": [
            {
                "id": r.id,
                "legacyItemId": r.legacy_item_id,
                "legacyFeatureId": r.legacy_feature_id,
                "legacyValue": r.legacy_value,
                "newAttributeId": r.new_attribute_id,
                "newValue": r.new_value,
                "attributeType": r.attribute_type or "",
                "condition": r.condition,
                "formula": r.formula,
                "mappedFrom": r.mapped_from,
                "valueStatus": r.value_status,
                "manifestEntryId": r.manifest_entry_id,
                "signedOnByUsername": r.signed_on_by_username,
                "signedOnAt": r.signed_on_at,
                "updatedAt": r.updated_at,
                "version": r.version,
                "createdBy": r.created_by,
                "modifiedBy": r.modified_by,
                "modifiedAt": r.modified_at,
                "feasibility": r.feasibility,
                "attributeFootprint": r.attribute_footprint,
                "valueFootprint": r.value_footprint,
                "candidateAttributeIds": r.candidate_attribute_ids_json,
            }
            for r in rows
        ],
        "total": len(rows),
    }


@router.get("/merged-workspace-mappings/{item_id}/detail")
def get_merged_workspace_mappings_detail(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return merged mappings, combo items, and shared VL detail for one item.

    - mappings: the merged workspace mapping rows
    - comboItems: other items sharing the same attribute_footprint
    - sharedVL: per-attribute shared value list info
    """
    MWM = models.MergedWorkspaceMapping

    # 1. All merged mappings for this item
    rows = (
        db.query(MWM)
        .filter(MWM.legacy_item_id == item_id)
        .order_by(MWM.legacy_feature_id.asc(), MWM.legacy_value.asc())
        .all()
    )
    mappings = [
        {
            "id": r.id,
            "legacyItemId": r.legacy_item_id,
            "legacyFeatureId": r.legacy_feature_id,
            "legacyValue": r.legacy_value,
            "newAttributeId": r.new_attribute_id,
            "newValue": r.new_value,
            "attributeType": r.attribute_type or "",
            "condition": r.condition,
            "feasibility": r.feasibility,
            "candidateAttributeIds": r.candidate_attribute_ids_json,
        }
        for r in rows
    ]

    # 2. Combo items — items sharing the same attribute_footprint
    attr_fp = None
    legacy_fp = None
    if rows:
        attr_fp = rows[0].attribute_footprint
        legacy_fp = rows[0].legacy_feature_footprint
    combo_items: list[dict] = []
    total_combo_items = 0
    if attr_fp:
        total_combo_items = db.execute(
            sa_text("""
                SELECT COUNT(DISTINCT m.legacy_item_id)
                FROM merged_workspace_mappings m
                WHERE m.attribute_footprint = :afp
                  AND m.legacy_item_id != :iid
            """),
            {"afp": attr_fp, "iid": item_id},
        ).scalar() or 0
        combo_rows = (
            db.execute(
                sa_text("""
                    SELECT DISTINCT m.legacy_item_id, b.description
                    FROM merged_workspace_mappings m
                    LEFT JOIN bom_items b ON b.item_id = m.legacy_item_id
                    WHERE m.attribute_footprint = :afp
                      AND m.legacy_item_id != :iid
                    ORDER BY m.legacy_item_id
                """),
                {"afp": attr_fp, "iid": item_id},
            ).fetchall()
        )
        combo_items = [{"itemId": r[0], "description": r[1] or ""} for r in combo_rows]

    # 3. Shared VL — per-attribute: find attributes where this item's
    #    value_footprint matches other items' value_footprint
    # First gather this item's per-attribute value footprints
    item_attr_fps = (
        db.execute(
            sa_text("""
                SELECT DISTINCT TRIM(new_attribute_id) as attr_id, value_footprint
                FROM merged_workspace_mappings
                WHERE legacy_item_id = :iid
                  AND value_footprint IS NOT NULL
                  AND TRIM(new_attribute_id) != ''
            """),
            {"iid": item_id},
        ).fetchall()
    )
    shared_vl: list[dict] = []
    for attr_id, vfp in item_attr_fps:
        if not vfp:
            continue
        # Find other items with the same value_footprint for the same attribute
        shared_rows = db.execute(
            sa_text("""
                SELECT DISTINCT m.legacy_item_id
                FROM merged_workspace_mappings m
                WHERE m.value_footprint = :vfp
                  AND TRIM(m.new_attribute_id) = :attr
                  AND m.legacy_item_id != :iid
                ORDER BY m.legacy_item_id
            """),
            {"vfp": vfp, "attr": attr_id, "iid": item_id},
        ).fetchall()
        if shared_rows:
            # Get the shared values
            val_rows = db.execute(
                sa_text("""
                    SELECT DISTINCT TRIM(new_value) as val
                    FROM merged_workspace_mappings
                    WHERE legacy_item_id = :iid
                      AND TRIM(new_attribute_id) = :attr
                      AND feasibility = 'Yes'
                      AND TRIM(new_value) != ''
                    ORDER BY val
                """),
                {"iid": item_id, "attr": attr_id},
            ).fetchall()
            shared_vl.append({
                "attribute": attr_id,
                "values": [r[0] for r in val_rows],
                "sharedItems": [r[0] for r in shared_rows],
                "totalShared": len(shared_rows),
            })

    # 4. Legacy combo items — items sharing the same legacy_feature_footprint
    legacy_combo_items: list[dict] = []
    total_legacy_combo_items = 0
    if legacy_fp:
        total_legacy_combo_items = db.execute(
            sa_text("""
                SELECT COUNT(DISTINCT m.legacy_item_id)
                FROM merged_workspace_mappings m
                WHERE m.legacy_feature_footprint = :lfp
                  AND m.legacy_item_id != :iid
            """),
            {"lfp": legacy_fp, "iid": item_id},
        ).scalar() or 0
        legacy_combo_rows = db.execute(
            sa_text("""
                SELECT DISTINCT m.legacy_item_id, b.description
                FROM merged_workspace_mappings m
                LEFT JOIN bom_items b ON b.item_id = m.legacy_item_id
                WHERE m.legacy_feature_footprint = :lfp
                  AND m.legacy_item_id != :iid
                ORDER BY m.legacy_item_id
            """),
            {"lfp": legacy_fp, "iid": item_id},
        ).fetchall()
        legacy_combo_items = [{"itemId": r[0], "description": r[1] or ""} for r in legacy_combo_rows]

    # 5. Legacy shared VL — per-feature: find items sharing same legacy_value_footprint
    item_legacy_fps = (
        db.execute(
            sa_text("""
                SELECT DISTINCT TRIM(legacy_feature_id) as feat_id, legacy_value_footprint
                FROM merged_workspace_mappings
                WHERE legacy_item_id = :iid
                  AND legacy_value_footprint IS NOT NULL
                  AND TRIM(legacy_feature_id) != ''
            """),
            {"iid": item_id},
        ).fetchall()
    )
    legacy_shared_vl: list[dict] = []
    for feat_id, lvfp in item_legacy_fps:
        if not lvfp:
            continue
        shared_rows = db.execute(
            sa_text("""
                SELECT DISTINCT m.legacy_item_id
                FROM merged_workspace_mappings m
                WHERE m.legacy_value_footprint = :lvfp
                  AND TRIM(m.legacy_feature_id) = :feat
                  AND m.legacy_item_id != :iid
                ORDER BY m.legacy_item_id
            """),
            {"lvfp": lvfp, "feat": feat_id, "iid": item_id},
        ).fetchall()
        if shared_rows:
            val_rows = db.execute(
                sa_text("""
                    SELECT DISTINCT TRIM(legacy_value) as val
                    FROM merged_workspace_mappings
                    WHERE legacy_item_id = :iid
                      AND TRIM(legacy_feature_id) = :feat
                      AND TRIM(legacy_value) != ''
                    ORDER BY val
                """),
                {"iid": item_id, "feat": feat_id},
            ).fetchall()
            legacy_shared_vl.append({
                "feature": feat_id,
                "values": [r[0] for r in val_rows],
                "sharedItems": [r[0] for r in shared_rows],
                "totalShared": len(shared_rows),
            })

    # Read stored footprint component lists from manifest_item_stats
    fp_lists_row = db.execute(
        sa_text("""SELECT footprint_attr_list, footprint_legacy_feature_list,
                       footprint_value_list, footprint_legacy_value_list
                FROM manifest_item_stats WHERE item_id = :iid"""),
        {"iid": item_id},
    ).first()
    fp_attr_list = fp_lists_row.footprint_attr_list.split("|") if fp_lists_row and fp_lists_row.footprint_attr_list else []
    fp_legacy_feature_list = fp_lists_row.footprint_legacy_feature_list.split("|") if fp_lists_row and fp_lists_row.footprint_legacy_feature_list else []
    fp_value_list = fp_lists_row.footprint_value_list.split("|") if fp_lists_row and fp_lists_row.footprint_value_list else []
    fp_legacy_value_list = fp_lists_row.footprint_legacy_value_list.split("|") if fp_lists_row and fp_lists_row.footprint_legacy_value_list else []

    return {
        "mappings": mappings,
        "totalMappings": len(mappings),
        "comboItems": combo_items,
        "totalComboItems": total_combo_items,
        "sharedVL": shared_vl,
        "attributeFootprint": attr_fp,
        "legacyComboItems": legacy_combo_items,
        "totalLegacyComboItems": total_legacy_combo_items,
        "legacySharedVL": legacy_shared_vl,
        "legacyFeatureFootprint": legacy_fp,
        "footprintAttrs": fp_attr_list,
        "footprintLegacyFeatures": fp_legacy_feature_list,
        "footprintValues": fp_value_list,
        "footprintLegacyValues": fp_legacy_value_list,
    }


@router.get("/merged-workspace-mappings-summary")
def get_merged_workspace_mappings_summary(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return a summary of merged workspace mappings with dashboard metrics."""
    total_rows = db.query(func.count(models.MergedWorkspaceMapping.id)).scalar() or 0
    distinct_items = db.query(func.count(func.distinct(models.MergedWorkspaceMapping.legacy_item_id))).scalar() or 0

    # Dashboard metrics from manifest_item_stats (pre-computed, fast)
    stats_count = db.execute(sa_text("SELECT COUNT(*) FROM manifest_item_stats")).scalar() or 0
    if stats_count > 0:
        metrics_row = db.execute(sa_text("""
            SELECT
                SUM(CASE WHEN attribute_footprint IS NULL OR attribute_footprint = '' THEN 1 ELSE 0 END) as empty_afp,
                COUNT(DISTINCT CASE WHEN attribute_footprint IS NOT NULL AND attribute_footprint != '' THEN attribute_footprint END) as unique_afp,
                SUM(CASE WHEN shared_vl_count > 0 THEN 1 ELSE 0 END) as items_with_shared_vl,
                SUM(shared_vl_count) as total_shared_vl_attrs,
                SUM(CASE WHEN combo_item_count > 1 THEN 1 ELSE 0 END) as items_with_combo,
                MAX(combo_item_count) as max_combo,
                SUM(CASE WHEN legacy_feature_footprint IS NULL OR legacy_feature_footprint = '' THEN 1 ELSE 0 END) as empty_lfp,
                COUNT(DISTINCT CASE WHEN legacy_feature_footprint IS NOT NULL AND legacy_feature_footprint != '' THEN legacy_feature_footprint END) as unique_lfp
            FROM manifest_item_stats
        """)).fetchone()
        empty_afp = metrics_row[0] or 0
        unique_afp = metrics_row[1] or 0
        items_with_shared_vl = metrics_row[2] or 0
        total_shared_vl_attrs = metrics_row[3] or 0
        items_with_combo = metrics_row[4] or 0
        max_combo = metrics_row[5] or 0
        empty_lfp = metrics_row[6] or 0
        unique_lfp = metrics_row[7] or 0

        # Unique value footprints from merged_workspace_mappings
        vfp_row = db.execute(sa_text("""
            SELECT
                COUNT(DISTINCT CASE WHEN value_footprint IS NOT NULL THEN value_footprint END) as unique_vfp,
                COUNT(DISTINCT CASE WHEN value_footprint IS NULL AND TRIM(new_attribute_id) != '' THEN legacy_item_id || '|' || TRIM(new_attribute_id) END) as empty_vfp_attrs,
                COUNT(DISTINCT CASE WHEN legacy_value_footprint IS NOT NULL THEN legacy_value_footprint END) as unique_lvfp,
                COUNT(DISTINCT CASE WHEN legacy_value_footprint IS NULL AND TRIM(legacy_feature_id) != '' THEN legacy_item_id || '|' || TRIM(legacy_feature_id) END) as empty_lvfp_attrs,
                COUNT(DISTINCT CASE WHEN legacy_value_footprint IS NOT NULL AND TRIM(legacy_feature_id) != '' THEN legacy_item_id || '|' || TRIM(legacy_feature_id) END) as covered_lvfp_attrs,
                COUNT(DISTINCT CASE WHEN legacy_value_footprint IS NOT NULL THEN legacy_item_id END) as items_with_any_lvfp
            FROM merged_workspace_mappings
        """)).fetchone()
        unique_vfp = vfp_row[0] or 0
        empty_vfp_attrs = vfp_row[1] or 0
        unique_lvfp = vfp_row[2] or 0
        empty_lvfp_attrs = vfp_row[3] or 0
        covered_lvfp_attrs = vfp_row[4] or 0
        items_with_any_lvfp = vfp_row[5] or 0
    else:
        empty_afp = 0
        unique_afp = 0
        items_with_shared_vl = 0
        total_shared_vl_attrs = 0
        items_with_combo = 0
        max_combo = 0
        unique_vfp = 0
        empty_vfp_attrs = 0
        empty_lfp = 0
        unique_lfp = 0
        unique_lvfp = 0
        empty_lvfp_attrs = 0
        covered_lvfp_attrs = 0
        items_with_any_lvfp = 0

    # Per-item footprint detail with dimensions for frontend filtering
    footprint_items = []
    if stats_count > 0:
        fp_rows = db.execute(sa_text("""
            SELECT
                COALESCE(b.category, 'Unknown') as category,
                COALESCE(b.product_type, 'Unknown') as product_type,
                COALESCE(CAST(b.priority AS TEXT), 'Unknown') as priority,
                m.attribute_footprint,
                COUNT(*) as item_count,
                COALESCE(b.classification, 'NA') as classification
            FROM manifest_item_stats m
            JOIN bom_items b ON b.item_id = m.item_id
            GROUP BY COALESCE(b.category, 'Unknown'),
                     COALESCE(b.product_type, 'Unknown'),
                     COALESCE(CAST(b.priority AS TEXT), 'Unknown'),
                     m.attribute_footprint,
                     COALESCE(b.classification, 'NA')
        """)).fetchall()
        for r in fp_rows:
            footprint_items.append({
                "category": str(r[0]),
                "productType": str(r[1]),
                "priority": str(r[2]),
                "hasAttrFp": bool(r[3] and r[3].strip()),
                "attrFp": str(r[3] or ""),
                "count": int(r[4]),
                "classification": str(r[5]),
            })

    # Distinct filter options
    filter_options = {"categories": [], "productTypes": [], "priorities": []}
    if stats_count > 0:
        filter_options["categories"] = sorted(set(r["category"] for r in footprint_items))
        filter_options["productTypes"] = sorted(set(r["productType"] for r in footprint_items))
        filter_options["priorities"] = sorted(set(r["priority"] for r in footprint_items))
        filter_options["classifications"] = sorted(set(r["classification"] for r in footprint_items))

    # Attribute label per footprint hash (sorted attr IDs joined with " · ")
    fp_attr_labels: dict = {}
    if stats_count > 0:
        label_rows = db.execute(sa_text("""
            SELECT attribute_footprint, GROUP_CONCAT(new_attribute_id, ' · ')
            FROM (
                SELECT DISTINCT attribute_footprint, TRIM(new_attribute_id) AS new_attribute_id
                FROM merged_workspace_mappings
                WHERE attribute_footprint IS NOT NULL
                  AND TRIM(new_attribute_id) != ''
                ORDER BY attribute_footprint, TRIM(new_attribute_id)
            )
            GROUP BY attribute_footprint
        """)).fetchall()
        fp_attr_labels = {r[0]: r[1] for r in label_rows}

    return {
        "totalRows": int(total_rows),
        "distinctItems": int(distinct_items),
        "metrics": {
            "emptyAttributeFootprints": int(empty_afp),
            "uniqueAttributeFootprints": int(unique_afp),
            "itemsWithCombo": int(items_with_combo),
            "maxComboSize": int(max_combo),
            "uniqueValueFootprints": int(unique_vfp),
            "emptyValueFootprintAttrs": int(empty_vfp_attrs),
            "itemsWithSharedVL": int(items_with_shared_vl),
            "totalSharedVLAttrs": int(total_shared_vl_attrs),
            "uniqueLegacyFeatureFootprints": int(unique_lfp),
            "emptyLegacyFeatureFootprints": int(empty_lfp),
            "uniqueLegacyValueFootprints": int(unique_lvfp),
            "emptyLegacyValueFootprintAttrs": int(empty_lvfp_attrs),
            "coveredLegacyValueFootprintAttrs": int(covered_lvfp_attrs),
            "itemsWithAnyLegacyValue": int(items_with_any_lvfp),
        },
        "footprintItems": footprint_items,
        "filterOptions": filter_options,
        "fpAttrLabels": fp_attr_labels,
    }


# ---------------------------------------------------------------------------
# Merge Batch Job — copies workspace_mappings → merged_workspace_mappings
# with feasibility, attribute_footprint, and value_footprint.
# ---------------------------------------------------------------------------

_merge_job_lock = asyncio.Lock()

_INACTIVE_VALUE_STATUSES = {"ignored", "deprecated", "discontinued", "not_required"}


def _run_merge_batch_job(job_id: int):
    """Background task: copy included workspace mappings to merged_workspace_mappings,
    compute feasibility, attribute_footprint, and value_footprint per item.

    Uses raw SQL for performance with millions of rows (INSERT INTO ... SELECT,
    then UPDATE footprints via aggregation).
    """
    db = SessionLocal()
    try:
        job = db.query(models.MergeJob).filter(models.MergeJob.id == job_id).first()
        if not job:
            return
        now_ts = time.time()
        job.status = "running"
        job.started_at = now_ts
        job.updated_at = now_ts
        db.commit()

        conn = db.connection()

        # Batch job copies ALL attribute types (no type filtering on INSERT)
        # But attribute_footprint only considers included types from config
        included_type_set = _get_included_type_set(db)
        attr_type_filter_sql = ""
        if included_type_set:
            type_placeholders = ",".join(f"'{t}'" for t in included_type_set)
            attr_type_filter_sql = f"AND LOWER(TRIM(attribute_type)) IN ({type_placeholders})"

        # Step 2: clear existing merged workspace mappings
        db.execute(sa_text("DELETE FROM merged_workspace_mappings"))
        db.commit()

        # Step 3: bulk copy workspace_mappings → merged_workspace_mappings with feasibility
        insert_sql = f"""
            INSERT INTO merged_workspace_mappings (
                legacy_item_id, legacy_feature_id, legacy_value,
                new_attribute_id, new_value, attribute_type,
                condition, formula, mapped_from, value_status,
                feasibility,
                signed_on_by_user_id, signed_on_by_username, signed_on_at,
                updated_at, version, created_by, modified_by, modified_at,
                attribute_footprint, value_footprint,
                candidate_attribute_ids_json
            )
            SELECT
                ws.legacy_item_id, ws.legacy_feature_id, COALESCE(ws.legacy_value, ''),
                COALESCE(ws.new_attribute_id, ''), COALESCE(ws.new_value, ''), COALESCE(ws.attribute_type, ''),
                ws.condition, ws.formula, COALESCE(ws.mapped_from, 'global'), ws.value_status,
                CASE
                    WHEN LOWER(TRIM(COALESCE(ws.value_status, ''))) IN ('ignored','deprecated','discontinued','not_required')
                         OR UPPER(TRIM(COALESCE(ws.new_value, ''))) = 'NOT REQUIRED'
                    THEN 'No'
                    ELSE 'Yes'
                END,
                ws.signed_on_by_user_id, ws.signed_on_by_username, ws.signed_on_at,
                {now_ts}, 1, ws.created_by, NULL, NULL,
                NULL, NULL,
                ws.candidate_attribute_ids_json
            FROM workspace_mappings ws
            WHERE 1=1
        """
        db.execute(sa_text(insert_sql))
        db.commit()

        # Get row counts
        generated = db.execute(sa_text("SELECT count(*) FROM merged_workspace_mappings")).scalar() or 0
        distinct_count = db.execute(
            sa_text("SELECT count(DISTINCT legacy_item_id) FROM merged_workspace_mappings")
        ).scalar() or 0

        job.total_items = distinct_count
        job.generated_rows = generated
        job.updated_at = time.time()
        db.commit()

        # Step 4: compute attribute_footprint per item via SQL
        logger.info("Merge job %s: computing footprints for %d items...", job_id, distinct_count)

        FOOTPRINT_BATCH = 5000
        offset = 0
        item_ids_q = db.execute(
            sa_text("SELECT DISTINCT legacy_item_id FROM merged_workspace_mappings ORDER BY legacy_item_id")
        )
        all_item_ids = [r[0] for r in item_ids_q]

        processed = 0
        # Accumulate footprint component lists across all batches for Step 5
        all_attr_list_map: Dict[str, str] = {}
        all_legacy_feat_list_map: Dict[str, str] = {}
        all_value_list_map: Dict[str, str] = {}
        all_legacy_value_list_map: Dict[str, str] = {}
        while offset < len(all_item_ids):
            batch_ids = all_item_ids[offset:offset + FOOTPRINT_BATCH]
            placeholders = ",".join(f"'{iid}'" for iid in batch_ids)

            # Attribute footprint: sorted distinct new_attribute_id per item
            # Only considers included attribute types from config
            attr_rows = db.execute(
                sa_text(f"""SELECT legacy_item_id,
                           GROUP_CONCAT(attr_id, '|')
                    FROM (
                        SELECT DISTINCT legacy_item_id, TRIM(new_attribute_id) as attr_id
                        FROM merged_workspace_mappings
                        WHERE legacy_item_id IN ({placeholders})
                          AND TRIM(new_attribute_id) != ''
                          {attr_type_filter_sql}
                        ORDER BY legacy_item_id, attr_id
                    )
                    GROUP BY legacy_item_id""")
            ).fetchall()

            attr_fp_map: Dict[str, str] = {}
            attr_list_map: Dict[str, str] = {}
            for iid, concat_attrs in attr_rows:
                sorted_attrs = "|".join(sorted(concat_attrs.split("|"))) if concat_attrs else ""
                attr_fp_map[iid] = hashlib.md5(sorted_attrs.encode()).hexdigest()
                attr_list_map[iid] = sorted_attrs

            # Value footprint: per (item, attribute) — hash of sorted mapped values
            # for that specific attribute within the item.
            # Only considers included attribute types from config
            val_rows = db.execute(
                sa_text(f"""SELECT legacy_item_id, attr_id,
                           GROUP_CONCAT(val, '|')
                    FROM (
                        SELECT DISTINCT legacy_item_id,
                               TRIM(new_attribute_id) as attr_id,
                               TRIM(new_value) as val
                        FROM merged_workspace_mappings
                        WHERE legacy_item_id IN ({placeholders})
                          AND feasibility = 'Yes'
                          AND TRIM(new_value) != ''
                          AND TRIM(new_attribute_id) != ''
                          {attr_type_filter_sql}
                        ORDER BY legacy_item_id, attr_id, val
                    )
                    GROUP BY legacy_item_id, attr_id""")
            ).fetchall()

            # Build map: (item_id, attr_id) -> hash, also collect flat value list per item
            val_fp_map: Dict[tuple, str] = {}
            item_value_set: Dict[str, set] = {}
            for iid, attr_id, concat_vals in val_rows:
                vals = sorted(set(concat_vals.split("|"))) if concat_vals else []
                val_key = "|".join(vals)
                val_fp_map[(iid, attr_id)] = hashlib.md5(val_key.encode()).hexdigest()
                item_value_set.setdefault(iid, set()).update(vals)
            value_list_map: Dict[str, str] = {iid: "|".join(sorted(vs)) for iid, vs in item_value_set.items()}

            # Legacy feature footprint: sorted distinct legacy_feature_id per item
            # Only considers included attribute types from config
            legacy_feat_rows = db.execute(
                sa_text(f"""SELECT legacy_item_id,
                           GROUP_CONCAT(feat_id, '|')
                    FROM (
                        SELECT DISTINCT legacy_item_id, TRIM(legacy_feature_id) as feat_id
                        FROM merged_workspace_mappings
                        WHERE legacy_item_id IN ({placeholders})
                          AND TRIM(legacy_feature_id) != ''
                          {attr_type_filter_sql}
                        ORDER BY legacy_item_id, feat_id
                    )
                    GROUP BY legacy_item_id""")
            ).fetchall()

            legacy_feat_fp_map: Dict[str, str] = {}
            legacy_feat_list_map: Dict[str, str] = {}
            for iid, concat_feats in legacy_feat_rows:
                sorted_feats = "|".join(sorted(concat_feats.split("|"))) if concat_feats else ""
                legacy_feat_fp_map[iid] = hashlib.md5(sorted_feats.encode()).hexdigest()
                legacy_feat_list_map[iid] = sorted_feats

            # Legacy value footprint: per (item, legacy_feature) — hash of sorted legacy values
            # Only considers included attribute types from config, feasibility = 'Yes'
            legacy_val_rows = db.execute(
                sa_text(f"""SELECT legacy_item_id, feat_id,
                           GROUP_CONCAT(val, '|')
                    FROM (
                        SELECT DISTINCT legacy_item_id,
                               TRIM(legacy_feature_id) as feat_id,
                               TRIM(legacy_value) as val
                        FROM merged_workspace_mappings
                        WHERE legacy_item_id IN ({placeholders})
                          AND feasibility = 'Yes'
                          AND TRIM(legacy_value) != ''
                          AND TRIM(legacy_feature_id) != ''
                          {attr_type_filter_sql}
                        ORDER BY legacy_item_id, feat_id, val
                    )
                    GROUP BY legacy_item_id, feat_id""")
            ).fetchall()

            legacy_val_fp_map: Dict[tuple, str] = {}
            item_legacy_value_set: Dict[str, set] = {}
            for iid, feat_id, concat_vals in legacy_val_rows:
                vals = sorted(set(concat_vals.split("|"))) if concat_vals else []
                val_key = "|".join(vals)
                legacy_val_fp_map[(iid, feat_id)] = hashlib.md5(val_key.encode()).hexdigest()
                item_legacy_value_set.setdefault(iid, set()).update(vals)
            legacy_value_list_map: Dict[str, str] = {iid: "|".join(sorted(vs)) for iid, vs in item_legacy_value_set.items()}

            # Batch update footprints
            for iid in batch_ids:
                afp = attr_fp_map.get(iid, "")
                lfp = legacy_feat_fp_map.get(iid, "")
                # Set attribute_footprint + legacy_feature_footprint on all rows, clear per-row footprints first
                db.execute(
                    sa_text("UPDATE merged_workspace_mappings SET attribute_footprint = :afp, value_footprint = NULL, legacy_feature_footprint = :lfp, legacy_value_footprint = NULL WHERE legacy_item_id = :iid"),
                    {"afp": afp, "lfp": lfp, "iid": iid},
                )
                # Set value_footprint per (item, attribute) group
                for (fp_iid, fp_attr), vfp in val_fp_map.items():
                    if fp_iid == iid:
                        db.execute(
                            sa_text("UPDATE merged_workspace_mappings SET value_footprint = :vfp WHERE legacy_item_id = :iid AND TRIM(new_attribute_id) = :attr"),
                            {"vfp": vfp, "iid": iid, "attr": fp_attr},
                        )
                # Set legacy_value_footprint per (item, legacy_feature) group
                for (fp_iid, fp_feat), lvfp in legacy_val_fp_map.items():
                    if fp_iid == iid:
                        db.execute(
                            sa_text("UPDATE merged_workspace_mappings SET legacy_value_footprint = :lvfp WHERE legacy_item_id = :iid AND TRIM(legacy_feature_id) = :feat"),
                            {"lvfp": lvfp, "iid": iid, "feat": fp_feat},
                        )

            # Merge batch maps into accumulators
            all_attr_list_map.update(attr_list_map)
            all_legacy_feat_list_map.update(legacy_feat_list_map)
            all_value_list_map.update(value_list_map)
            all_legacy_value_list_map.update(legacy_value_list_map)

            processed += len(batch_ids)
            job.processed_items = processed
            job.updated_at = time.time()
            db.commit()

            offset += FOOTPRINT_BATCH

        # Step 5: Pre-compute manifest_item_stats for fast API reads
        logger.info("Merge job %s: computing manifest item stats...", job_id)
        db.execute(sa_text("DELETE FROM manifest_item_stats"))
        db.commit()

        # Per-item: attr_count, mapped_count, attribute_footprint, legacy_feature_footprint
        db.execute(sa_text("""
            INSERT INTO manifest_item_stats (item_id, attr_count, mapped_count, attribute_footprint, legacy_feature_footprint, legacy_value_footprint, combo_item_count, shared_vl_count, legacy_combo_item_count, legacy_shared_vl_count)
            SELECT
                legacy_item_id,
                COUNT(DISTINCT CASE WHEN TRIM(new_attribute_id) != '' THEN TRIM(new_attribute_id) END),
                COUNT(DISTINCT CASE WHEN feasibility = 'Yes' AND TRIM(new_value) != '' AND TRIM(new_attribute_id) != '' THEN TRIM(new_attribute_id) END),
                MAX(attribute_footprint),
                MAX(legacy_feature_footprint),
                MAX(legacy_value_footprint),
                1,
                0,
                1,
                0
            FROM merged_workspace_mappings
            GROUP BY legacy_item_id
        """))
        db.commit()

        # Populate footprint component lists from accumulated maps
        FP_LIST_BATCH = 2000
        fp_items = list(set(list(all_attr_list_map.keys()) + list(all_legacy_feat_list_map.keys()) + list(all_value_list_map.keys()) + list(all_legacy_value_list_map.keys())))
        for i in range(0, len(fp_items), FP_LIST_BATCH):
            batch = fp_items[i:i + FP_LIST_BATCH]
            for iid in batch:
                db.execute(
                    sa_text("""UPDATE manifest_item_stats
                        SET footprint_attr_list = :al,
                            footprint_legacy_feature_list = :fl,
                            footprint_value_list = :vl,
                            footprint_legacy_value_list = :lvl
                        WHERE item_id = :iid"""),
                    {
                        "al": all_attr_list_map.get(iid, ""),
                        "fl": all_legacy_feat_list_map.get(iid, ""),
                        "vl": all_value_list_map.get(iid, ""),
                        "lvl": all_legacy_value_list_map.get(iid, ""),
                        "iid": iid,
                    },
                )
            db.commit()

        # Update combo_item_count from attribute_footprint grouping
        db.execute(sa_text("""
            UPDATE manifest_item_stats
            SET combo_item_count = (
                SELECT COUNT(DISTINCT m.legacy_item_id)
                FROM merged_workspace_mappings m
                WHERE m.attribute_footprint = manifest_item_stats.attribute_footprint
                  AND manifest_item_stats.attribute_footprint IS NOT NULL
                  AND manifest_item_stats.attribute_footprint != ''
            )
            WHERE attribute_footprint IS NOT NULL AND attribute_footprint != ''
        """))
        db.commit()

        # Update shared_vl_count: count of attributes with shared value_footprint
        db.execute(sa_text("""
            UPDATE manifest_item_stats
            SET shared_vl_count = COALESCE((
                SELECT COUNT(DISTINCT sub.attr)
                FROM (
                    SELECT DISTINCT legacy_item_id, TRIM(new_attribute_id) as attr, value_footprint
                    FROM merged_workspace_mappings
                    WHERE value_footprint IS NOT NULL AND TRIM(new_attribute_id) != ''
                ) sub
                INNER JOIN (
                    SELECT TRIM(new_attribute_id) as attr, value_footprint
                    FROM merged_workspace_mappings
                    WHERE value_footprint IS NOT NULL AND TRIM(new_attribute_id) != ''
                    GROUP BY TRIM(new_attribute_id), value_footprint
                    HAVING COUNT(DISTINCT legacy_item_id) >= 2
                ) shared ON shared.attr = sub.attr AND shared.value_footprint = sub.value_footprint
                WHERE sub.legacy_item_id = manifest_item_stats.item_id
            ), 0)
        """))
        db.commit()

        # Update legacy_combo_item_count from legacy_feature_footprint grouping
        db.execute(sa_text("""
            UPDATE manifest_item_stats
            SET legacy_combo_item_count = (
                SELECT COUNT(DISTINCT m.legacy_item_id)
                FROM merged_workspace_mappings m
                WHERE m.legacy_feature_footprint = manifest_item_stats.legacy_feature_footprint
                  AND manifest_item_stats.legacy_feature_footprint IS NOT NULL
                  AND manifest_item_stats.legacy_feature_footprint != ''
            )
            WHERE legacy_feature_footprint IS NOT NULL AND legacy_feature_footprint != ''
        """))
        db.commit()

        # Update legacy_shared_vl_count: count of legacy features with shared legacy_value_footprint
        db.execute(sa_text("""
            UPDATE manifest_item_stats
            SET legacy_shared_vl_count = COALESCE((
                SELECT COUNT(DISTINCT sub.feat)
                FROM (
                    SELECT DISTINCT legacy_item_id, TRIM(legacy_feature_id) as feat, legacy_value_footprint
                    FROM merged_workspace_mappings
                    WHERE legacy_value_footprint IS NOT NULL AND TRIM(legacy_feature_id) != ''
                ) sub
                INNER JOIN (
                    SELECT TRIM(legacy_feature_id) as feat, legacy_value_footprint
                    FROM merged_workspace_mappings
                    WHERE legacy_value_footprint IS NOT NULL AND TRIM(legacy_feature_id) != ''
                    GROUP BY TRIM(legacy_feature_id), legacy_value_footprint
                    HAVING COUNT(DISTINCT legacy_item_id) >= 2
                ) shared ON shared.feat = sub.feat AND shared.legacy_value_footprint = sub.legacy_value_footprint
                WHERE sub.legacy_item_id = manifest_item_stats.item_id
            ), 0)
        """))
        db.commit()

        logger.info("Merge job %s: manifest item stats computed.", job_id)

        job.status = "completed"
        job.finished_at = time.time()
        job.updated_at = time.time()
        db.commit()
        logger.info("Merge job %s completed: %d rows, %d items", job_id, generated, distinct_count)

    except Exception as exc:
        logger.exception("Merge batch job %s failed", job_id)
        db.rollback()
        try:
            job = db.query(models.MergeJob).filter(models.MergeJob.id == job_id).first()
            if job:
                job.status = "failed"
                job.error_message = str(exc)[:500]
                job.finished_at = time.time()
                job.updated_at = time.time()
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


async def _run_merge_batch_job_async(job_id: int):
    """Acquire async lock and run merge batch job in a thread pool executor."""
    async with _merge_job_lock:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, _run_merge_batch_job, job_id)


@router.post("/merge-job/trigger")
def trigger_merge_batch_job(
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Trigger the merge batch job. Returns the job ID for progress polling."""
    # Check for running job
    running = (
        db.query(models.MergeJob)
        .filter(models.MergeJob.status.in_(["queued", "running"]))
        .first()
    )
    if running:
        return {"ok": False, "error": "A merge job is already running", "jobId": running.id}

    job = models.MergeJob(
        status="queued",
        triggered_by_username=getattr(current_user, "username", None),
        updated_at=time.time(),
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    background_tasks.add_task(_run_merge_batch_job_async, job.id)
    return {"ok": True, "jobId": job.id}


@router.get("/merge-job/progress")
def get_merge_job_progress(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return the latest merge job status."""
    job = (
        db.query(models.MergeJob)
        .order_by(models.MergeJob.id.desc())
        .first()
    )
    if not job:
        return {"hasJob": False}
    return {
        "hasJob": True,
        "jobId": job.id,
        "status": job.status,
        "totalItems": job.total_items,
        "processedItems": job.processed_items,
        "generatedRows": job.generated_rows,
        "startedAt": job.started_at,
        "finishedAt": job.finished_at,
        "errorMessage": job.error_message,
    }


# ---------------------------------------------------------------------------
# Valuelist Strategy endpoints
# ---------------------------------------------------------------------------

_EXCLUDED_NEW_VALUES = {"NOT REQUIRED", ""}
_EXCLUDED_VALUE_STATUSES = {"ignored", "deprecated", "discontinued"}


def _run_valuelist_strategy_analysis(job_id: int, strategy: str):
    """Background task: census, classification, dedup for valuelist strategy."""
    db = SessionLocal()
    try:
        job = db.query(models.ValuelistStrategyJob).get(job_id)
        if not job:
            return
        job.status = "running"
        db.commit()

        # ------------------------------------------------------------------
        # Phase A-1: Target Attribute Census
        # ------------------------------------------------------------------
        merged_rows = (
            db.query(models.MergedWorkspaceMapping)
            .all()
        )

        # Build: { new_attribute_id -> { legacy_item_id -> [new_value] } }
        attr_items: Dict[str, Dict[str, List[str]]] = {}
        for r in merged_rows:
            nv = (r.new_value or "").strip()
            vs = (r.value_status or "").strip().lower()
            # Pre-filter: exclude NOT REQUIRED and excluded statuses
            if nv.upper() in _EXCLUDED_NEW_VALUES:
                continue
            if vs in _EXCLUDED_VALUE_STATUSES:
                continue
            attr_items.setdefault(r.new_attribute_id, {}).setdefault(r.legacy_item_id, []).append(nv)

        # ------------------------------------------------------------------
        # Phase A-2: Attribute Classification
        # ------------------------------------------------------------------
        now = time.time()
        profiles: List[models.TargetAttributeProfile] = []
        fixed_count = 0
        vl_count = 0

        for attr_id, item_values in attr_items.items():
            max_vals = max((len(vals) for vals in item_values.values()), default=0)
            classification = "fixed_only" if max_vals <= 1 else "valuelist"

            all_values = sorted({v for vals in item_values.values() for v in vals})
            fixed_items = sum(1 for vals in item_values.values() if len(vals) == 1)
            multi_items = sum(1 for vals in item_values.values() if len(vals) > 1)

            if classification == "fixed_only":
                fixed_count += 1
            else:
                vl_count += 1

            profiles.append(models.TargetAttributeProfile(
                target_attribute_id=attr_id,
                classification=classification,
                total_items=len(item_values),
                fixed_value_items=fixed_items,
                multi_value_items=multi_items,
                canonical_values_json=all_values if classification == "valuelist" else None,
                noise_values_json=None,
                dedup_group_key=None,
                job_id=job_id,
                created_at=now,
                updated_at=now,
            ))

        # Clear previous profiles for this job (or all)
        db.query(models.TargetAttributeProfile).delete()
        db.bulk_save_objects(profiles)
        db.flush()

        # ------------------------------------------------------------------
        # Phase A-3: Valuelist Deduplication
        # ------------------------------------------------------------------
        # Re-query to get IDs assigned
        all_profiles = db.query(models.TargetAttributeProfile).all()
        hash_groups: Dict[str, List[models.TargetAttributeProfile]] = {}
        for p in all_profiles:
            if p.classification != "valuelist" or not p.canonical_values_json:
                continue
            sorted_vals = sorted(p.canonical_values_json)
            key = hashlib.sha256("|".join(sorted_vals).encode()).hexdigest()[:16]
            p.dedup_group_key = key
            hash_groups.setdefault(key, []).append(p)

        unique_vl_count = 0
        vl_counter = 0
        for key, group in hash_groups.items():
            vl_counter += 1
            unique_vl_count += 1
            vl_id = f"VL-STRATEGY-{vl_counter:04d}"
            for p in group:
                p.valuelist_id = vl_id

        db.flush()

        # Update job
        job.total_attributes = len(attr_items)
        job.fixed_only_count = fixed_count
        job.valuelist_count = vl_count
        job.unique_valuelists = unique_vl_count
        job.status = "completed"
        job.completed_at = time.time()
        db.commit()
    except Exception as exc:
        db.rollback()
        try:
            job = db.query(models.ValuelistStrategyJob).get(job_id)
            if job:
                job.status = "failed"
                job.error_message = str(exc)[:500]
                job.completed_at = time.time()
                db.commit()
        except Exception:
            pass
        logger.exception("Valuelist strategy analysis failed for job %s", job_id)
    finally:
        db.close()


@router.post("/valuelist-strategy/analyze")
def valuelist_strategy_analyze(
    background_tasks: BackgroundTasks,
    body: dict = Body(default={}),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Trigger census + classification + dedup background job."""
    strategy = body.get("strategy", "conservative")
    if strategy not in ("conservative", "aggressive"):
        raise HTTPException(status_code=400, detail="strategy must be 'conservative' or 'aggressive'")

    job = models.ValuelistStrategyJob(
        status="queued",
        strategy=strategy,
        created_at=time.time(),
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    background_tasks.add_task(_run_valuelist_strategy_analysis, job.id, strategy)
    return {"jobId": job.id, "status": job.status}


@router.get("/valuelist-strategy/job/{job_id}")
def valuelist_strategy_job_status(
    job_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Poll job status + summary stats."""
    job = db.query(models.ValuelistStrategyJob).get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {
        "jobId": job.id,
        "status": job.status,
        "strategy": job.strategy,
        "totalAttributes": job.total_attributes,
        "fixedOnlyCount": job.fixed_only_count,
        "valuelistCount": job.valuelist_count,
        "uniqueValuelists": job.unique_valuelists,
        "mergedValuelists": job.merged_valuelists,
        "errorMessage": job.error_message,
        "createdAt": job.created_at,
        "completedAt": job.completed_at,
    }


@router.get("/valuelist-strategy/profiles")
def valuelist_strategy_profiles(
    classification: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Paginated list of TargetAttributeProfile rows."""
    q = db.query(models.TargetAttributeProfile)
    if classification:
        q = q.filter(models.TargetAttributeProfile.classification == classification)
    if search:
        q = q.filter(models.TargetAttributeProfile.target_attribute_id.ilike(f"%{search}%"))
    total = q.count()
    rows = q.order_by(models.TargetAttributeProfile.target_attribute_id.asc()).offset(offset).limit(limit).all()
    return {
        "items": [
            {
                "id": r.id,
                "targetAttributeId": r.target_attribute_id,
                "classification": r.classification,
                "valuelistId": r.valuelist_id,
                "totalItems": r.total_items,
                "fixedValueItems": r.fixed_value_items,
                "multiValueItems": r.multi_value_items,
                "canonicalValues": r.canonical_values_json or [],
                "noiseValues": r.noise_values_json or [],
                "dedupGroupKey": r.dedup_group_key,
                "jobId": r.job_id,
                "createdAt": r.created_at,
                "updatedAt": r.updated_at,
            }
            for r in rows
        ],
        "total": total,
    }


@router.get("/valuelist-strategy/profiles/{attribute_id}")
def valuelist_strategy_profile_detail(
    attribute_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Single attribute profile detail."""
    profile = (
        db.query(models.TargetAttributeProfile)
        .filter(models.TargetAttributeProfile.target_attribute_id == attribute_id)
        .first()
    )
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    # Also find sibling profiles sharing the same dedup group
    siblings = []
    if profile.dedup_group_key:
        sibling_rows = (
            db.query(models.TargetAttributeProfile)
            .filter(
                models.TargetAttributeProfile.dedup_group_key == profile.dedup_group_key,
                models.TargetAttributeProfile.id != profile.id,
            )
            .all()
        )
        siblings = [s.target_attribute_id for s in sibling_rows]

    return {
        "id": profile.id,
        "targetAttributeId": profile.target_attribute_id,
        "classification": profile.classification,
        "valuelistId": profile.valuelist_id,
        "totalItems": profile.total_items,
        "fixedValueItems": profile.fixed_value_items,
        "multiValueItems": profile.multi_value_items,
        "canonicalValues": profile.canonical_values_json or [],
        "noiseValues": profile.noise_values_json or [],
        "dedupGroupKey": profile.dedup_group_key,
        "dedupSiblings": siblings,
        "jobId": profile.job_id,
        "createdAt": profile.created_at,
        "updatedAt": profile.updated_at,
    }


@router.get("/valuelist-strategy/dedup-groups")
def valuelist_strategy_dedup_groups(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Grouped view: which attributes share identical value sets."""
    profiles = (
        db.query(models.TargetAttributeProfile)
        .filter(models.TargetAttributeProfile.dedup_group_key.isnot(None))
        .order_by(models.TargetAttributeProfile.dedup_group_key.asc())
        .all()
    )

    groups: Dict[str, Any] = {}
    for p in profiles:
        key = p.dedup_group_key
        if key not in groups:
            groups[key] = {
                "dedupGroupKey": key,
                "valuelistId": p.valuelist_id,
                "canonicalValues": p.canonical_values_json or [],
                "attributes": [],
            }
        groups[key]["attributes"].append({
            "targetAttributeId": p.target_attribute_id,
            "totalItems": p.total_items,
            "fixedValueItems": p.fixed_value_items,
            "multiValueItems": p.multi_value_items,
        })

    return {"groups": list(groups.values()), "totalGroups": len(groups)}


@router.post("/valuelist-strategy/merge-preview")
def valuelist_strategy_merge_preview(
    body: dict = Body(default={}),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Preview superset merge with overlap threshold.

    Returns proposed merges plus noise cost for each.
    """
    threshold = body.get("threshold", 0.8)
    strategy = body.get("strategy", "conservative")

    # Get all dedup groups
    profiles = (
        db.query(models.TargetAttributeProfile)
        .filter(
            models.TargetAttributeProfile.classification == "valuelist",
            models.TargetAttributeProfile.valuelist_id.isnot(None),
        )
        .all()
    )

    # Group by valuelist_id to get unique lists
    vl_map: Dict[str, Any] = {}
    for p in profiles:
        vl_id = p.valuelist_id
        if vl_id not in vl_map:
            vl_map[vl_id] = {
                "valuelistId": vl_id,
                "values": set(p.canonical_values_json or []),
                "attributes": [],
                "totalItems": 0,
            }
        vl_map[vl_id]["attributes"].append(p.target_attribute_id)
        vl_map[vl_id]["totalItems"] += p.total_items

    vl_list = list(vl_map.values())
    proposals = []

    for i, a in enumerate(vl_list):
        for j, b in enumerate(vl_list):
            if j <= i:
                continue
            set_a = a["values"]
            set_b = b["values"]
            if not set_a or not set_b:
                continue

            intersection = set_a & set_b
            union = set_a | set_b
            overlap = len(intersection) / len(union) if union else 0

            is_subset = set_a <= set_b or set_b <= set_a
            should_merge = False

            if strategy == "conservative":
                should_merge = is_subset
            else:  # aggressive
                should_merge = overlap >= threshold

            if should_merge:
                noise_for_a = len(union - set_a)
                noise_for_b = len(union - set_b)
                proposals.append({
                    "listA": a["valuelistId"],
                    "listB": b["valuelistId"],
                    "attributesA": a["attributes"],
                    "attributesB": b["attributes"],
                    "mergedValues": sorted(union),
                    "overlapPercent": round(overlap * 100, 1),
                    "isSubset": is_subset,
                    "noiseAddedToA": noise_for_a,
                    "noiseAddedToB": noise_for_b,
                    "affectedItemsA": a["totalItems"],
                    "affectedItemsB": b["totalItems"],
                })

    return {
        "proposals": proposals,
        "totalProposals": len(proposals),
        "strategy": strategy,
        "threshold": threshold,
    }


@router.post("/valuelist-strategy/apply")
def valuelist_strategy_apply(
    body: dict = Body(default={}),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Commit: create ValueList rows, update profiles and merged workspace mappings.

    Accepts optional merge overrides from the merge-preview step.
    """
    merge_overrides = body.get("mergeOverrides", [])  # [{ listA, listB, mergedValuelistId }]

    # Build merge map: old valuelist_id -> new valuelist_id
    merge_map: Dict[str, str] = {}
    for override in merge_overrides:
        merged_id = override.get("mergedValuelistId") or override.get("listA")
        for key in ("listA", "listB"):
            old_id = override.get(key)
            if old_id and old_id != merged_id:
                merge_map[old_id] = merged_id

    profiles = (
        db.query(models.TargetAttributeProfile)
        .filter(models.TargetAttributeProfile.classification == "valuelist")
        .all()
    )

    now = time.time()
    created_vl_ids = set()
    vl_rows_created = 0
    profiles_updated = 0
    mappings_updated = 0

    for p in profiles:
        raw_vl_id = p.valuelist_id
        if not raw_vl_id:
            continue

        # Apply merge override
        effective_vl_id = merge_map.get(raw_vl_id, raw_vl_id)
        p.valuelist_id = effective_vl_id
        p.updated_at = now
        profiles_updated += 1

        # Create ValueList rows if not yet created
        if effective_vl_id not in created_vl_ids:
            # Delete existing rows for this valuelist_id
            db.query(models.ValueList).filter(models.ValueList.valuelist_id == effective_vl_id).delete()
            canonical = p.canonical_values_json or []
            # If merged, union with other canonical sets
            if raw_vl_id in merge_map:
                for other_p in profiles:
                    if other_p.valuelist_id == effective_vl_id and other_p.canonical_values_json:
                        canonical = sorted(set(canonical) | set(other_p.canonical_values_json))
            for val in canonical:
                db.add(models.ValueList(
                    valuelist_id=effective_vl_id,
                    value=val,
                ))
                vl_rows_created += 1
            created_vl_ids.add(effective_vl_id)

        # Update merged workspace mappings for this attribute
        mapping_rows = (
            db.query(models.MergedWorkspaceMapping)
            .filter(models.MergedWorkspaceMapping.new_attribute_id == p.target_attribute_id)
            .all()
        )
        for m in mapping_rows:
            m.valuelist_id = effective_vl_id
            # Mark single-value items as effective fixed
            nv = (m.new_value or "").strip()
            vs = (m.value_status or "").strip().lower()
            if nv.upper() in _EXCLUDED_NEW_VALUES or vs in _EXCLUDED_VALUE_STATUSES:
                m.is_effective_fixed = 0
            elif p.fixed_value_items > 0 and p.multi_value_items > 0:
                # Only mark as effective_fixed if the item has exactly 1 value
                item_vals = [
                    r.new_value
                    for r in db.query(models.MergedWorkspaceMapping)
                    .filter(
                        models.MergedWorkspaceMapping.legacy_item_id == m.legacy_item_id,
                        models.MergedWorkspaceMapping.new_attribute_id == p.target_attribute_id,
                    )
                    .all()
                    if (r.new_value or "").strip().upper() not in _EXCLUDED_NEW_VALUES
                    and (r.value_status or "").strip().lower() not in _EXCLUDED_VALUE_STATUSES
                ]
                m.is_effective_fixed = 1 if len(item_vals) == 1 else 0
            else:
                m.is_effective_fixed = 0
            mappings_updated += 1

    # Update job merged_valuelists count if merges happened
    if merge_overrides:
        latest_job = (
            db.query(models.ValuelistStrategyJob)
            .filter(models.ValuelistStrategyJob.status == "completed")
            .order_by(models.ValuelistStrategyJob.id.desc())
            .first()
        )
        if latest_job:
            latest_job.merged_valuelists = len(created_vl_ids)

    db.commit()

    _audit(db, current_user, "valuelist_strategy_apply", f"Created {len(created_vl_ids)} valuelists with {vl_rows_created} value rows, updated {profiles_updated} profiles and {mappings_updated} mappings")

    return {
        "ok": True,
        "valuelistsCreated": len(created_vl_ids),
        "valuelistRowsCreated": vl_rows_created,
        "profilesUpdated": profiles_updated,
        "mappingsUpdated": mappings_updated,
    }
