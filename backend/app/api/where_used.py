"""Where Used: usage of target attributes/values and legacy features/values.

All usage counts come from ``workspace_mappings``. Rows with zero usage are
surfaced from the catalogues instead -- ``classifications`` for the target side
and ``bom_features`` for the legacy side -- so definitions that nothing maps to
stay visible as cleanup targets.

Every aggregate is an index-only scan over ``ix_wu_target`` / ``ix_wu_legacy``
(see migration 0049) and is memoised for ``CACHE_TTL_SECONDS``.
"""

import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, case, distinct, func, or_
from sqlalchemy.orm import Session

from ..core.security import get_current_user
from ..db import models
from ..db.session import get_db

router = APIRouter(tags=["where-used"], dependencies=[Depends(get_current_user)])

MAX_SEARCH_LENGTH = 100
CACHE_TTL_SECONDS = 120.0
# Catalogues only change on import, so they outlive the usage aggregates.
CATALOGUE_TTL_SECONDS = 900.0
DEFAULT_LIMIT = 50
MAX_LIMIT = 500
OPTION_LIMIT = 50

# Target ids/values that are placeholders rather than real targets. They are
# surfaced as their own rows so their size stays visible.
SENTINELS = ("UNMAPPED", "NOT REQUIRED")
BLANK_KEY = "__blank__"
BLANK_LABEL = "(blank)"

WM = models.WorkspaceMapping

_cache: Dict[str, Tuple[float, Any]] = {}


def _cache_get(key: str) -> Any:
    hit = _cache.get(key)
    if hit and time.time() < hit[0]:
        return hit[1]
    return None


def _cache_set(key: str, value: Any, ttl: float = CACHE_TTL_SECONDS) -> Any:
    _cache[key] = (time.time() + ttl, value)
    return value


def invalidate_where_used_cache() -> None:
    _cache.clear()


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _norm(value: Optional[str]) -> str:
    return (value or "").strip().upper()


def _csv_list(value: Optional[str]) -> List[str]:
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def _filter_keys(rows: List[dict], field: str, keys: List[str]) -> List[dict]:
    """Restrict rows to an explicit selection, matched case-insensitively."""
    if not keys:
        return rows
    wanted = {k.upper() for k in keys}
    return [r for r in rows if str(r.get(field) or "").upper() in wanted]


def _clean_search(value: Optional[str]) -> str:
    text = (value or "").strip()
    if len(text) > MAX_SEARCH_LENGTH:
        raise HTTPException(status_code=400, detail=f"search too long (max {MAX_SEARCH_LENGTH} chars)")
    return text


def _is_sentinel(value: Optional[str]) -> bool:
    normalized = _norm(value)
    return normalized == "" or normalized in SENTINELS


def _trimmed(column) -> Any:
    return func.trim(func.coalesce(column, ""))


def _countable_value():
    """A row that contributes a real legacy value -> real target value pair."""
    return and_(
        _trimmed(WM.legacy_value) != "",
        _trimmed(WM.new_value) != "",
        func.upper(_trimmed(WM.new_value)).notin_(SENTINELS),
    )


def _real_target_attribute():
    return and_(
        _trimmed(WM.new_attribute_id) != "",
        func.upper(_trimmed(WM.new_attribute_id)).notin_(SENTINELS),
    )


def _apply_attribute_types(query, attribute_types: List[str]):
    if not attribute_types:
        return query
    lowered = [t.lower() for t in attribute_types]
    return query.filter(func.lower(_trimmed(WM.attribute_type)).in_(lowered))


def _paginate(rows: List[dict], offset: int, limit: int) -> dict:
    window = rows[offset: offset + limit + 1]
    has_more = len(window) > limit
    return {
        "items": window[:limit],
        "hasMore": has_more,
        "offset": offset,
        "limit": limit,
    }


def _sort_rows(rows: List[dict], sort_by: Optional[str], sort_dir: Optional[str], allowed: Dict[str, str], default: str, label_key: str):
    key = allowed.get(sort_by or "", allowed[default])
    descending = (sort_dir or "desc").lower() != "asc"
    # Sort stability gives ties a deterministic alphabetical order, which keeps
    # offset paging from reshuffling rows between requests.
    rows.sort(key=lambda r: str(r.get(label_key) or "").lower())
    rows.sort(key=lambda r: r.get(key) if isinstance(r.get(key), int) else str(r.get(key) or "").lower(), reverse=descending)
    return rows


# ---------------------------------------------------------------------------
# Catalogues (sources of zero-usage rows)
# ---------------------------------------------------------------------------

def _classification_attributes(db: Session) -> Dict[str, dict]:
    """Every attribute declared by any classification, keyed by upper-cased id."""
    cached = _cache_get("cat:attrs")
    if cached is not None:
        return cached

    catalogue: Dict[str, dict] = {}
    for (attributes,) in db.query(models.Classification.attributes).all():
        for attr in attributes or []:
            attribute_id = str(attr.get("attributeId") or "").strip()
            if not attribute_id:
                continue
            key = attribute_id.upper()
            entry = catalogue.setdefault(key, {"attributeId": attribute_id, "description": ""})
            if not entry["description"]:
                entry["description"] = str(attr.get("description") or "").strip()
    return _cache_set("cat:attrs", catalogue, CATALOGUE_TTL_SECONDS)


def _classification_all_values(db: Session) -> Dict[str, str]:
    """Every allowed value declared by any classification, keyed by upper-cased value."""
    cached = _cache_get("cat:allvals")
    if cached is not None:
        return cached

    values: Dict[str, str] = {}
    for (attributes,) in db.query(models.Classification.attributes).all():
        for attr in attributes or []:
            for raw in attr.get("allowedValues") or []:
                value = str(raw).strip()
                if value:
                    values.setdefault(value.upper(), value)
    return _cache_set("cat:allvals", values, CATALOGUE_TTL_SECONDS)


def _classification_allowed_values(db: Session, attribute_id: str) -> Dict[str, str]:
    """Allowed values declared for one attribute across all classes, keyed by upper-cased value."""
    target = _norm(attribute_id)
    if not target:
        return {}
    cached = _cache_get(f"cat:vals:{target}")
    if cached is not None:
        return cached

    values: Dict[str, str] = {}
    for (attributes,) in db.query(models.Classification.attributes).all():
        for attr in attributes or []:
            if _norm(attr.get("attributeId")) != target:
                continue
            for raw in attr.get("allowedValues") or []:
                value = str(raw).strip()
                if value:
                    values.setdefault(value.upper(), value)
    return _cache_set(f"cat:vals:{target}", values, CATALOGUE_TTL_SECONDS)


def _bom_features(db: Session) -> Dict[str, dict]:
    """Every legacy feature present on any BOM item, keyed by upper-cased id."""
    cached = _cache_get("cat:features")
    if cached is not None:
        return cached

    catalogue: Dict[str, dict] = {}
    rows = (
        db.query(models.BomFeature.feature_id, func.min(models.BomFeature.description))
        .group_by(models.BomFeature.feature_id)
        .all()
    )
    for feature_id, description in rows:
        clean = str(feature_id or "").strip()
        if clean:
            catalogue[clean.upper()] = {"featureId": clean, "description": str(description or "").strip()}
    return _cache_set("cat:features", catalogue, CATALOGUE_TTL_SECONDS)


def _expand_value_blobs(rows) -> Dict[str, str]:
    """Collect option strings from `values_json` rows.

    The column holds either a plain list or a richer
    ``{"values": [...], "valueDescriptions": {...}}`` object; mirrors the
    normalisation in state.py. Iterating the dict directly would yield its keys.
    """
    values: Dict[str, str] = {}
    for (raw_values,) in rows:
        if isinstance(raw_values, dict):
            raw_values = raw_values.get("values") or []
        if not isinstance(raw_values, list):
            continue
        for raw in raw_values:
            value = str(raw).strip()
            if value:
                values.setdefault(value.upper(), value)
    return values


def _bom_feature_values(db: Session, feature_id: str) -> Dict[str, str]:
    """Options declared on BOM items for one legacy feature, keyed by upper-cased value."""
    target = _norm(feature_id)
    if not target:
        return {}
    cached = _cache_get(f"cat:fvals:{target}")
    if cached is not None:
        return cached

    rows = (
        db.query(models.BomFeature.values)
        .filter(func.upper(_trimmed(models.BomFeature.feature_id)) == target)
        .distinct()
        .all()
    )
    return _cache_set(f"cat:fvals:{target}", _expand_value_blobs(rows), CATALOGUE_TTL_SECONDS)


def _bom_all_values(db: Session) -> Dict[str, str]:
    """Every option present on any BOM feature, keyed by upper-cased value.

    Features overwhelmingly share identical value arrays, so de-duplicating the
    JSON blobs in SQL collapses ~900k rows into a far smaller set to expand.
    """
    cached = _cache_get("cat:allfvals")
    if cached is not None:
        return cached
    rows = db.query(models.BomFeature.values).distinct().all()
    return _cache_set("cat:allfvals", _expand_value_blobs(rows), CATALOGUE_TTL_SECONDS)


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------

@router.get("/where-used/filters")
def get_where_used_filters(db: Session = Depends(get_db)):
    """Distinct attribute types available for filtering."""
    cached = _cache_get("filters")
    if cached is not None:
        return cached
    rows = db.query(WM.attribute_type).distinct().all()
    types = sorted({(r[0] or "").strip() for r in rows if (r[0] or "").strip()})
    return _cache_set("filters", {"attributeTypes": types})


# ---------------------------------------------------------------------------
# Dropdown options
# ---------------------------------------------------------------------------

def _option_pool(db: Session, scope: str, parent: str) -> Dict[str, str]:
    """Selectable options for a tab, keyed by upper-cased value.

    Sourced purely from the catalogues (classifications / bom_features), so
    values that only exist in workspace_mappings are deliberately absent.
    """
    if scope == "targetAttributes":
        return {k: v["attributeId"] for k, v in _classification_attributes(db).items()}
    if scope == "targetValues":
        return _classification_allowed_values(db, parent) if parent and parent != BLANK_KEY else _classification_all_values(db)
    if scope == "legacyFeatures":
        return {k: v["featureId"] for k, v in _bom_features(db).items()}
    return _bom_feature_values(db, parent) if parent and parent != BLANK_KEY else _bom_all_values(db)


@router.get("/where-used/options")
def list_where_used_options(
    scope: str = Query(..., pattern="^(targetAttributes|targetValues|legacyFeatures|legacyValues)$"),
    search: Optional[str] = None,
    parent: Optional[str] = None,
    limit: int = Query(OPTION_LIMIT, ge=1, le=MAX_LIMIT),
    db: Session = Depends(get_db),
):
    """Catalogue options for the Where Used filter dropdowns."""
    term = _clean_search(search).lower()
    pool = _option_pool(db, scope, (parent or "").strip())

    descriptions: Dict[str, str] = {}
    if scope == "targetAttributes":
        descriptions = {k: v["description"] for k, v in _classification_attributes(db).items()}
    elif scope == "legacyFeatures":
        descriptions = {k: v["description"] for k, v in _bom_features(db).items()}

    matches = [
        {"value": label, "description": descriptions.get(key, "")}
        for key, label in pool.items()
        if not term or term in label.lower() or term in descriptions.get(key, "").lower()
    ]
    matches.sort(key=lambda o: o["value"].lower())

    return {"items": matches[:limit], "hasMore": len(matches) > limit, "total": len(matches)}


# ---------------------------------------------------------------------------
# Target attributes
# ---------------------------------------------------------------------------

def _target_attribute_rows(db: Session, attribute_types: List[str]) -> List[dict]:
    cache_key = "ta:" + ",".join(sorted(t.lower() for t in attribute_types))
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    query = db.query(
        WM.new_attribute_id,
        func.count(distinct(WM.legacy_item_id)),
        func.count(distinct(WM.legacy_feature_id)),
        func.count(distinct(case((_countable_value(), WM.new_value)))),
        func.count(distinct(case((_trimmed(WM.legacy_value) != "", WM.legacy_value)))),
    )
    query = _apply_attribute_types(query, attribute_types)
    aggregated = query.group_by(WM.new_attribute_id).all()

    catalogue = _classification_attributes(db)
    rows: List[dict] = []
    seen: set = set()
    for attribute_id, item_count, feature_count, value_count, legacy_value_count in aggregated:
        clean = str(attribute_id or "").strip()
        key = clean.upper()
        seen.add(key)
        rows.append({
            "key": clean or BLANK_KEY,
            "attributeId": clean or BLANK_LABEL,
            "description": catalogue.get(key, {}).get("description", ""),
            "itemCount": int(item_count or 0),
            "legacyFeatureCount": int(feature_count or 0),
            "valueCount": int(value_count or 0),
            "legacyValueCount": int(legacy_value_count or 0),
            "isSentinel": _is_sentinel(clean),
            "inClassifications": key in catalogue,
        })

    # Attribute types are a property of mapping rows, so an unused catalogue
    # attribute cannot be attributed to one. Omit them when that filter is on.
    if not attribute_types:
        for key, entry in catalogue.items():
            if key in seen:
                continue
            rows.append({
                "key": entry["attributeId"],
                "attributeId": entry["attributeId"],
                "description": entry["description"],
                "itemCount": 0,
                "legacyFeatureCount": 0,
                "valueCount": 0,
                "legacyValueCount": 0,
                "isSentinel": False,
                "inClassifications": True,
            })

    return _cache_set(cache_key, rows)


_TARGET_ATTR_SORTS = {
    "itemCount": "itemCount",
    "legacyFeatureCount": "legacyFeatureCount",
    "valueCount": "valueCount",
    "legacyValueCount": "legacyValueCount",
    "attributeId": "attributeId",
}


@router.get("/where-used/target-attributes")
def list_target_attribute_usage(
    search: Optional[str] = None,
    keys: Optional[str] = None,
    attributeType: Optional[str] = None,
    minCount: Optional[int] = None,
    maxCount: Optional[int] = None,
    sortBy: Optional[str] = None,
    sortDir: Optional[str] = None,
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    term = _clean_search(search).lower()
    rows = list(_target_attribute_rows(db, _csv_list(attributeType)))

    rows = _filter_keys(rows, "attributeId", _csv_list(keys))
    if term:
        rows = [r for r in rows if term in r["attributeId"].lower() or term in (r["description"] or "").lower()]
    if minCount is not None:
        rows = [r for r in rows if r["itemCount"] >= minCount]
    if maxCount is not None:
        rows = [r for r in rows if r["itemCount"] <= maxCount]

    _sort_rows(rows, sortBy, sortDir, _TARGET_ATTR_SORTS, "itemCount", "attributeId")
    return _paginate(rows, offset, limit)


# ---------------------------------------------------------------------------
# Target values
# ---------------------------------------------------------------------------

_TARGET_VALUE_SORTS = {
    "itemCount": "itemCount",
    "legacyFeatureCount": "legacyFeatureCount",
    "legacyValueCount": "legacyValueCount",
    "value": "value",
    "attributeId": "attributeId",
}


@router.get("/where-used/target-values")
def list_target_value_usage(
    attributeId: Optional[str] = None,
    search: Optional[str] = None,
    keys: Optional[str] = None,
    attributeType: Optional[str] = None,
    minCount: Optional[int] = None,
    maxCount: Optional[int] = None,
    sortBy: Optional[str] = None,
    sortDir: Optional[str] = None,
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    term = _clean_search(search)
    attribute_types = _csv_list(attributeType)
    attribute_key = (attributeId or "").strip()

    cache_key = f"tv:{attribute_key.lower()}|{term.lower()}|" + ",".join(sorted(t.lower() for t in attribute_types))
    rows = _cache_get(cache_key)

    if rows is None:
        query = db.query(
            WM.new_attribute_id,
            WM.new_value,
            func.count(distinct(WM.legacy_item_id)),
            func.count(distinct(WM.legacy_feature_id)),
            func.count(distinct(case((_trimmed(WM.legacy_value) != "", WM.legacy_value)))),
        )
        query = _apply_attribute_types(query, attribute_types)
        if attribute_key:
            resolved = "" if attribute_key == BLANK_KEY else attribute_key
            query = query.filter(func.upper(_trimmed(WM.new_attribute_id)) == resolved.upper())
        if term:
            like = f"%{term}%"
            query = query.filter(or_(WM.new_value.ilike(like), WM.new_attribute_id.ilike(like)))

        aggregated = query.group_by(WM.new_attribute_id, WM.new_value).all()

        rows = []
        seen: set = set()
        for attr, value, item_count, feature_count, legacy_value_count in aggregated:
            clean_attr = str(attr or "").strip()
            clean_value = str(value or "").strip()
            seen.add((clean_attr.upper(), clean_value.upper()))
            rows.append({
                "attributeKey": clean_attr or BLANK_KEY,
                "attributeId": clean_attr or BLANK_LABEL,
                "valueKey": clean_value or BLANK_KEY,
                "value": clean_value or BLANK_LABEL,
                "itemCount": int(item_count or 0),
                "legacyFeatureCount": int(feature_count or 0),
                "legacyValueCount": int(legacy_value_count or 0),
                "isSentinel": _is_sentinel(clean_value),
                "inClassifications": False,
            })

        # Unused allowed values only resolve for a single named attribute.
        if attribute_key and attribute_key != BLANK_KEY and not attribute_types:
            for value_key, value in _classification_allowed_values(db, attribute_key).items():
                if (attribute_key.upper(), value_key) in seen:
                    continue
                rows.append({
                    "attributeKey": attribute_key,
                    "attributeId": attribute_key,
                    "valueKey": value,
                    "value": value,
                    "itemCount": 0,
                    "legacyFeatureCount": 0,
                    "legacyValueCount": 0,
                    "isSentinel": False,
                    "inClassifications": True,
                })

        _cache_set(cache_key, rows)

    rows = list(rows)
    rows = _filter_keys(rows, "value", _csv_list(keys))
    if minCount is not None:
        rows = [r for r in rows if r["itemCount"] >= minCount]
    if maxCount is not None:
        rows = [r for r in rows if r["itemCount"] <= maxCount]

    _sort_rows(rows, sortBy, sortDir, _TARGET_VALUE_SORTS, "itemCount", "value")
    return _paginate(rows, offset, limit)


# ---------------------------------------------------------------------------
# Legacy features
# ---------------------------------------------------------------------------

def _legacy_feature_rows(db: Session, attribute_types: List[str]) -> List[dict]:
    cache_key = "lf:" + ",".join(sorted(t.lower() for t in attribute_types))
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    query = db.query(
        WM.legacy_feature_id,
        func.count(distinct(WM.legacy_item_id)),
        func.count(distinct(case((_real_target_attribute(), WM.new_attribute_id)))),
        func.count(distinct(case((_countable_value(), WM.new_value)))),
        func.count(distinct(case((_trimmed(WM.legacy_value) != "", WM.legacy_value)))),
    )
    query = _apply_attribute_types(query, attribute_types)
    aggregated = query.group_by(WM.legacy_feature_id).all()

    catalogue = _bom_features(db)
    rows: List[dict] = []
    seen: set = set()
    for feature_id, item_count, attr_count, value_count, legacy_value_count in aggregated:
        clean = str(feature_id or "").strip()
        key = clean.upper()
        seen.add(key)
        rows.append({
            "key": clean or BLANK_KEY,
            "featureId": clean or BLANK_LABEL,
            "description": catalogue.get(key, {}).get("description", ""),
            "itemCount": int(item_count or 0),
            "targetAttributeCount": int(attr_count or 0),
            "targetValueCount": int(value_count or 0),
            "legacyValueCount": int(legacy_value_count or 0),
            "inBom": key in catalogue,
        })

    if not attribute_types:
        for key, entry in catalogue.items():
            if key in seen:
                continue
            rows.append({
                "key": entry["featureId"],
                "featureId": entry["featureId"],
                "description": entry["description"],
                "itemCount": 0,
                "targetAttributeCount": 0,
                "targetValueCount": 0,
                "legacyValueCount": 0,
                "inBom": True,
            })

    return _cache_set(cache_key, rows)


_LEGACY_FEATURE_SORTS = {
    "itemCount": "itemCount",
    "targetAttributeCount": "targetAttributeCount",
    "targetValueCount": "targetValueCount",
    "legacyValueCount": "legacyValueCount",
    "featureId": "featureId",
}


@router.get("/where-used/legacy-features")
def list_legacy_feature_usage(
    search: Optional[str] = None,
    keys: Optional[str] = None,
    attributeType: Optional[str] = None,
    minCount: Optional[int] = None,
    maxCount: Optional[int] = None,
    sortBy: Optional[str] = None,
    sortDir: Optional[str] = None,
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    term = _clean_search(search).lower()
    rows = list(_legacy_feature_rows(db, _csv_list(attributeType)))

    rows = _filter_keys(rows, "featureId", _csv_list(keys))
    if term:
        rows = [r for r in rows if term in r["featureId"].lower() or term in (r["description"] or "").lower()]
    if minCount is not None:
        rows = [r for r in rows if r["itemCount"] >= minCount]
    if maxCount is not None:
        rows = [r for r in rows if r["itemCount"] <= maxCount]

    _sort_rows(rows, sortBy, sortDir, _LEGACY_FEATURE_SORTS, "itemCount", "featureId")
    return _paginate(rows, offset, limit)


# ---------------------------------------------------------------------------
# Legacy values
# ---------------------------------------------------------------------------

_LEGACY_VALUE_SORTS = {
    "itemCount": "itemCount",
    "targetAttributeCount": "targetAttributeCount",
    "targetValueCount": "targetValueCount",
    "value": "value",
    "featureId": "featureId",
}


@router.get("/where-used/legacy-values")
def list_legacy_value_usage(
    featureId: Optional[str] = None,
    search: Optional[str] = None,
    keys: Optional[str] = None,
    attributeType: Optional[str] = None,
    minCount: Optional[int] = None,
    maxCount: Optional[int] = None,
    sortBy: Optional[str] = None,
    sortDir: Optional[str] = None,
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    term = _clean_search(search)
    attribute_types = _csv_list(attributeType)
    feature_key = (featureId or "").strip()

    cache_key = f"lv:{feature_key.lower()}|{term.lower()}|" + ",".join(sorted(t.lower() for t in attribute_types))
    rows = _cache_get(cache_key)

    if rows is None:
        query = db.query(
            WM.legacy_feature_id,
            WM.legacy_value,
            func.count(distinct(WM.legacy_item_id)),
            func.count(distinct(case((_real_target_attribute(), WM.new_attribute_id)))),
            func.count(distinct(case((_countable_value(), WM.new_value)))),
        )
        query = _apply_attribute_types(query, attribute_types)
        if feature_key:
            resolved = "" if feature_key == BLANK_KEY else feature_key
            query = query.filter(func.upper(_trimmed(WM.legacy_feature_id)) == resolved.upper())
        if term:
            like = f"%{term}%"
            query = query.filter(or_(WM.legacy_value.ilike(like), WM.legacy_feature_id.ilike(like)))

        aggregated = query.group_by(WM.legacy_feature_id, WM.legacy_value).all()

        rows = []
        seen: set = set()
        for feature, value, item_count, attr_count, value_count in aggregated:
            clean_feature = str(feature or "").strip()
            clean_value = str(value or "").strip()
            seen.add((clean_feature.upper(), clean_value.upper()))
            rows.append({
                "featureKey": clean_feature or BLANK_KEY,
                "featureId": clean_feature or BLANK_LABEL,
                "valueKey": clean_value or BLANK_KEY,
                "value": clean_value or BLANK_LABEL,
                "itemCount": int(item_count or 0),
                "targetAttributeCount": int(attr_count or 0),
                "targetValueCount": int(value_count or 0),
                "inBom": False,
            })

        # Expanding values_json is only bounded when one feature is selected.
        if feature_key and feature_key != BLANK_KEY and not attribute_types:
            for value_key, value in _bom_feature_values(db, feature_key).items():
                if (feature_key.upper(), value_key) in seen:
                    continue
                rows.append({
                    "featureKey": feature_key,
                    "featureId": feature_key,
                    "valueKey": value,
                    "value": value,
                    "itemCount": 0,
                    "targetAttributeCount": 0,
                    "targetValueCount": 0,
                    "inBom": True,
                })

        _cache_set(cache_key, rows)

    rows = list(rows)
    rows = _filter_keys(rows, "value", _csv_list(keys))
    if minCount is not None:
        rows = [r for r in rows if r["itemCount"] >= minCount]
    if maxCount is not None:
        rows = [r for r in rows if r["itemCount"] <= maxCount]

    _sort_rows(rows, sortBy, sortDir, _LEGACY_VALUE_SORTS, "itemCount", "value")
    return _paginate(rows, offset, limit)


# ---------------------------------------------------------------------------
# Drill-down panels
# ---------------------------------------------------------------------------

def _scope_filter(query, side: str, key: str, value: Optional[str]):
    resolved_key = "" if key == BLANK_KEY else key
    if side == "legacy":
        query = query.filter(func.upper(_trimmed(WM.legacy_feature_id)) == resolved_key.upper())
        if value is not None:
            resolved_value = "" if value == BLANK_KEY else value
            query = query.filter(func.upper(_trimmed(WM.legacy_value)) == resolved_value.upper())
    else:
        query = query.filter(func.upper(_trimmed(WM.new_attribute_id)) == resolved_key.upper())
        if value is not None:
            resolved_value = "" if value == BLANK_KEY else value
            query = query.filter(func.upper(_trimmed(WM.new_value)) == resolved_value.upper())
    return query


@router.get("/where-used/items")
def list_where_used_items(
    side: str = Query(..., pattern="^(target|legacy)$"),
    key: str = Query(...),
    value: Optional[str] = None,
    attributeType: Optional[str] = None,
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    """BOM items whose workspace mappings touch the given attribute/feature (and value)."""
    attribute_types = _csv_list(attributeType)

    query = _apply_attribute_types(db.query(WM.legacy_item_id).distinct(), attribute_types)
    query = _scope_filter(query, side, key, value)
    item_ids = [r[0] for r in query.order_by(WM.legacy_item_id).offset(offset).limit(limit + 1).all()]

    has_more = len(item_ids) > limit
    item_ids = item_ids[:limit]

    by_id = {
        bi.item_id: bi
        for bi in db.query(models.BomItem).filter(models.BomItem.item_id.in_(item_ids)).all()
    } if item_ids else {}

    items = []
    for item_id in item_ids:
        bom_item = by_id.get(item_id)
        items.append({
            "itemId": item_id,
            "description": getattr(bom_item, "description", None) or "",
            "category": getattr(bom_item, "category", None) or "",
            "productType": getattr(bom_item, "product_type", None) or "",
            "priority": getattr(bom_item, "priority", None),
        })

    return {"items": items, "hasMore": has_more, "offset": offset, "limit": limit}


@router.get("/where-used/counterparts")
def list_where_used_counterparts(
    side: str = Query(..., pattern="^(target|legacy)$"),
    key: str = Query(...),
    value: Optional[str] = None,
    attributeType: Optional[str] = None,
    limit: int = Query(200, ge=1, le=MAX_LIMIT),
    db: Session = Depends(get_db),
):
    """The opposite side of the mapping for a row: what it maps to / comes from."""
    attribute_types = _csv_list(attributeType)

    if side == "legacy":
        left, right = WM.new_attribute_id, WM.new_value
    else:
        left, right = WM.legacy_feature_id, WM.legacy_value

    query = db.query(left, right, func.count(distinct(WM.legacy_item_id)))
    query = _apply_attribute_types(query, attribute_types)
    query = _scope_filter(query, side, key, value)
    rows = query.group_by(left, right).order_by(func.count(distinct(WM.legacy_item_id)).desc()).limit(limit).all()

    return {
        "side": "target" if side == "legacy" else "legacy",
        "items": [
            {
                "key": str(a or "").strip() or BLANK_LABEL,
                "value": str(b or "").strip() or BLANK_LABEL,
                "itemCount": int(count or 0),
            }
            for a, b, count in rows
        ],
    }
