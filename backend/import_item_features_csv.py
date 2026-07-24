"""
Import an "item features" CSV into the application's bom_items + bom_features
tables.

This is a STANDALONE, additive import path used by the ``/imports/item-features``
endpoint. It does NOT touch the existing dual-file feature import or the /sync
``bom_upload`` flow.

CSV shape (default layout)::

    item,model,sequence,feature,value,value,unit,GSAM00[AMFORM]

Notes:
- There are TWO columns literally named ``value`` (a character/code value and a
  numeric value). Because of the duplicate header, the file MUST be parsed by
  column INDEX (csv.reader), not by header name (csv.DictReader).
- The ``model`` and ``sequence`` columns are IGNORED. Models are aggregated away:
  a feature that appears under multiple models is collapsed into a single
  ``(item, feature)`` feature whose values are the UNION (de-duplicated) of every
  model's values.
- For each row the stored value is ``value_code`` when present, otherwise
  ``value_number`` (coalesce). Rows where both are empty are skipped.
- Items that already exist in ``bom_items`` are SKIPPED and reported (no
  replace / merge).

Usage (CLI)::

    cd backend
    python import_item_features_csv.py --csv "path/to/fixed item features.csv"
    python import_item_features_csv.py --csv "..." --dry-run
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

# ---------------------------------------------------------------------------
# Ensure the backend package is importable when running from <repo>/backend/
# ---------------------------------------------------------------------------
_BACKEND_ROOT = Path(__file__).resolve().parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.db.models import BomFeature, BomItem  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402


# ---------------------------------------------------------------------------
# Column mapping
# ---------------------------------------------------------------------------
# 0-based column indices for the canonical layout.
DEFAULT_COLUMN_MAPPING: Dict[str, int] = {
    "item": 0,
    "feature": 3,
    "valueCode": 4,
    "valueNumber": 5,
    "unit": 6,
}

# How often (in rows / features) to report progress and commit.
_PROGRESS_EVERY_ROWS = 20_000
_COMMIT_EVERY_FEATURES = 5_000


def _normalize_column_mapping(mapping: Optional[Dict[str, Any]]) -> Dict[str, Optional[int]]:
    """Validate + coerce a column mapping to ``{field: int_index_or_None}``.

    Required: ``item`` and ``feature`` plus at least one of
    ``valueCode`` / ``valueNumber``. ``unit`` is optional.
    """
    src = dict(DEFAULT_COLUMN_MAPPING) if not mapping else mapping

    def _coerce(field: str) -> Optional[int]:
        raw = src.get(field)
        if raw is None or raw == "":
            return None
        try:
            idx = int(raw)
        except (TypeError, ValueError):
            raise ValueError(f"Column mapping for '{field}' must be an integer index, got {raw!r}")
        if idx < 0:
            raise ValueError(f"Column mapping for '{field}' must be >= 0, got {idx}")
        return idx

    resolved: Dict[str, Optional[int]] = {
        "item": _coerce("item"),
        "feature": _coerce("feature"),
        "valueCode": _coerce("valueCode"),
        "valueNumber": _coerce("valueNumber"),
        "unit": _coerce("unit"),
    }

    if resolved["item"] is None:
        raise ValueError("Column mapping is missing required field 'item'")
    if resolved["feature"] is None:
        raise ValueError("Column mapping is missing required field 'feature'")
    if resolved["valueCode"] is None and resolved["valueNumber"] is None:
        raise ValueError("Column mapping needs at least one of 'valueCode' / 'valueNumber'")

    return resolved


def _cell(row: List[str], idx: Optional[int]) -> str:
    """Safely read a trimmed cell by index (empty string if out of range/None)."""
    if idx is None or idx < 0 or idx >= len(row):
        return ""
    val = row[idx]
    return val.strip() if isinstance(val, str) else ("" if val is None else str(val).strip())


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def _parse_grouped(
    csv_path: str,
    colmap: Dict[str, Optional[int]],
    progress_cb: Optional[Callable[..., None]] = None,
) -> tuple[Dict[str, "dict"], int, int]:
    """Stream the CSV and group rows by ``(item, feature)``.

    Returns ``(grouped, total_rows, rows_skipped_empty)`` where *grouped* is::

        { item_id: { feature_id: {"values": [...], "seen": set(), "unit": str|None} } }
    """
    grouped: Dict[str, Dict[str, dict]] = {}
    total_rows = 0
    rows_skipped_empty = 0

    with open(csv_path, "r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.reader(fh)
        # Skip the header row.
        try:
            next(reader)
        except StopIteration:
            return grouped, 0, 0

        for row in reader:
            total_rows += 1

            item_id = _cell(row, colmap["item"])
            feature_id = _cell(row, colmap["feature"])
            if not item_id or not feature_id:
                rows_skipped_empty += 1
            else:
                code = _cell(row, colmap["valueCode"])
                number = _cell(row, colmap["valueNumber"])
                value = code if code else number
                if not value:
                    rows_skipped_empty += 1
                else:
                    unit = _cell(row, colmap["unit"]) or None
                    features = grouped.setdefault(item_id, {})
                    entry = features.get(feature_id)
                    if entry is None:
                        entry = {"values": [], "seen": set(), "unit": unit}
                        features[feature_id] = entry
                    if value not in entry["seen"]:
                        entry["seen"].add(value)
                        entry["values"].append(value)
                    if entry["unit"] is None and unit:
                        entry["unit"] = unit

            if progress_cb and total_rows % _PROGRESS_EVERY_ROWS == 0:
                progress_cb(phase="parsing", processed_rows=total_rows)

    if progress_cb:
        progress_cb(phase="parsing", processed_rows=total_rows)

    return grouped, total_rows, rows_skipped_empty


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

def _extract_value_list(raw: Any) -> tuple[List[str], str, Any]:
    """Normalize a BomFeature.values payload to ``(values, kind, container)``.

    ``kind`` is one of ``"dict"`` / ``"list"`` / ``"none"`` so the caller can
    write the merged values back in the same shape (preserving any
    ``valueDescriptions`` / ``valueTillDates`` on the dict form).
    """
    if isinstance(raw, dict):
        return [str(v) for v in (raw.get("values") or [])], "dict", raw
    if isinstance(raw, list):
        return [str(v) for v in raw], "list", raw
    return [], "none", None


def run_import(
    csv_path: str,
    *,
    dry_run: bool = False,
    column_mapping: Optional[Dict[str, Any]] = None,
    progress_cb: Optional[Callable[..., None]] = None,
) -> Dict[str, Any]:
    """Import *csv_path* into bom_items + bom_features.

    New items are created with all of their features. For items that ALREADY
    exist, features are MERGED: missing features are added and, for features
    that already exist, only values not already present are appended (existing
    values are left intact).

    Returns a summary dict::

        {
          "created_items": int,       # brand-new items created
          "created_features": int,    # features created on new items
          "updated_items": int,       # existing items that gained features/values
          "added_features": int,      # new feature rows added to existing items
          "added_values": int,        # values appended to existing features
          "unchanged_items": int,     # existing items with nothing to add
          "updated_report": [ {item_id, added_features, added_values}, ... ],
          "rows_skipped_empty": int,
          "total_rows": int,
        }
    """
    path = Path(csv_path)
    if not path.exists():
        raise FileNotFoundError(f"CSV file not found: {path}")

    colmap = _normalize_column_mapping(column_mapping)

    grouped, total_rows, rows_skipped_empty = _parse_grouped(csv_path, colmap, progress_cb)

    total_items = len(grouped)
    created_items = 0
    created_features = 0
    updated_items = 0
    added_features = 0
    added_values = 0
    unchanged_items = 0
    updated_report: List[dict] = []

    session = SessionLocal()
    try:
        # Existing item_id -> primary key (used to merge into existing items).
        existing_id_by_item = {
            item_id: pk for (pk, item_id) in session.query(BomItem.id, BomItem.item_id).all()
        }

        processed_items = 0
        pending_writes = 0

        for item_id, features in grouped.items():
            processed_items += 1
            existing_pk = existing_id_by_item.get(item_id)

            if existing_pk is None:
                # Brand-new item: create it and all of its features.
                created_items += 1
                if not dry_run:
                    bom_item = BomItem(item_id=item_id)
                    session.add(bom_item)
                    session.flush()  # assign bom_item.id for the FK
                    for feature_id, entry in features.items():
                        session.add(
                            BomFeature(
                                item_id=bom_item.id,
                                feature_id=feature_id,
                                unit=entry["unit"],
                                values=list(entry["values"]),
                            )
                        )
                        created_features += 1
                        pending_writes += 1
                    existing_id_by_item[item_id] = bom_item.id
                else:
                    created_features += len(features)
            else:
                # Existing item: MERGE missing features / append new values.
                item_added_features = 0
                item_added_values = 0

                existing_feats = (
                    session.query(BomFeature)
                    .filter(BomFeature.item_id == existing_pk)
                    .all()
                )
                feat_by_id = {str(f.feature_id): f for f in existing_feats}

                for feature_id, entry in features.items():
                    csv_values = entry["values"]
                    feat = feat_by_id.get(feature_id)

                    if feat is None:
                        # Feature not present on this item yet — add it.
                        item_added_features += 1
                        item_added_values += len(csv_values)
                        if not dry_run:
                            session.add(
                                BomFeature(
                                    item_id=existing_pk,
                                    feature_id=feature_id,
                                    unit=entry["unit"],
                                    values=list(csv_values),
                                )
                            )
                            pending_writes += 1
                    else:
                        # Existing feature — append only values not already present.
                        existing_values, kind, container = _extract_value_list(feat.values)
                        seen = set(existing_values)
                        appended = [v for v in csv_values if v not in seen]
                        if appended:
                            item_added_values += len(appended)
                            if not dry_run:
                                merged = existing_values + appended
                                if kind == "dict":
                                    new_container = dict(container)
                                    new_container["values"] = merged
                                    feat.values = new_container
                                else:
                                    feat.values = merged
                                pending_writes += 1
                        # Backfill unit if it was missing.
                        if not dry_run and (not feat.unit) and entry["unit"]:
                            feat.unit = entry["unit"]

                if item_added_features or item_added_values:
                    updated_items += 1
                    added_features += item_added_features
                    added_values += item_added_values
                    if len(updated_report) < 100_000:
                        updated_report.append(
                            {
                                "item_id": item_id,
                                "added_features": item_added_features,
                                "added_values": item_added_values,
                            }
                        )
                else:
                    unchanged_items += 1

            if not dry_run and pending_writes >= _COMMIT_EVERY_FEATURES:
                session.commit()
                session.expunge_all()
                pending_writes = 0

            if progress_cb and processed_items % 1000 == 0:
                progress_cb(
                    phase="inserting",
                    processed_items=processed_items,
                    total_items=total_items,
                    created_items=created_items,
                    created_features=created_features,
                    updated_items=updated_items,
                    added_features=added_features,
                    added_values=added_values,
                )

        if not dry_run:
            session.commit()

    except Exception:
        if not dry_run:
            session.rollback()
        raise
    finally:
        session.close()

    if progress_cb:
        progress_cb(
            phase="done",
            processed_items=total_items,
            total_items=total_items,
            created_items=created_items,
            created_features=created_features,
            updated_items=updated_items,
            added_features=added_features,
            added_values=added_values,
        )

    return {
        "created_items": created_items,
        "created_features": created_features,
        "updated_items": updated_items,
        "added_features": added_features,
        "added_values": added_values,
        "unchanged_items": unchanged_items,
        "updated_report": updated_report,
        "rows_skipped_empty": rows_skipped_empty,
        "total_rows": total_rows,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Import item-features CSV into bom_items + bom_features.")
    parser.add_argument("--csv", required=True, help="Path to the item-features CSV file.")
    parser.add_argument("--dry-run", action="store_true", help="Parse and report counts without writing.")
    args = parser.parse_args()

    summary = run_import(args.csv, dry_run=args.dry_run)

    print(f"Total rows:            {summary['total_rows']}")
    print(f"Created items:         {summary['created_items']}")
    print(f"Created features:      {summary['created_features']}")
    print(f"Updated items:         {summary['updated_items']}")
    print(f"Added features:        {summary['added_features']}")
    print(f"Added values:          {summary['added_values']}")
    print(f"Unchanged items:       {summary['unchanged_items']}")
    print(f"Rows skipped (empty):  {summary['rows_skipped_empty']}")
    if args.dry_run:
        print("[DRY-RUN] No data was written.")


if __name__ == "__main__":
    main()
