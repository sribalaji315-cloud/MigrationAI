"""
One-time script: insert missing legacy feature values that were not loaded
during the original BOM import.

Reads a CSV with columns ``Item, Feature, From Value`` and, for each row:

  1. Adds the legacy value to the item's ``bom_features`` row
     (``values_json``).  If the item has no feature row for that feature a
     new ``BomFeature`` is created.

  2. Inserts a matching ``workspace_mappings`` row for
     (legacy_item_id, legacy_feature_id, legacy_value), applying the relevant
     ``GlobalMapping`` exactly the way the in-app mapping-generation job does
     (resolved new_value, attribute_type, target attribute / candidates and
     deprecated / ignored exclusion handling).

Behaviour (confirmed):
  * Missing feature row on an existing item  -> create a new BomFeature.
  * Existing workspace_mappings row          -> skip (insert-only, never
                                                overwrites manual edits).
  * Item not present in the database          -> skip and report in summary.
  * ``--dry-run`` reports counts without writing anything.

Usage:
    cd backend
    python insert_missing_feature_values.py --dry-run
    python insert_missing_feature_values.py
    python insert_missing_feature_values.py --csv "C:\\path\\to\\missing from values.csv"
"""

import argparse
import csv
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

_BACKEND_ROOT = Path(__file__).resolve().parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.db.models import BomFeature, BomItem, GlobalMapping, WorkspaceMapping
from app.db.session import Base


DEFAULT_CSV = (
    r"c:\Users\ISA2\OneDrive - HAWORTH INC\Downloads\migration app inputs"
    r"\missing from values.csv"
)

SCRIPT_TAG = "insert_missing_feature_values"


# --------------------------------------------------------------------------- #
# Helpers mirrored from app.api.state (kept local to avoid importing the very
# large state module and triggering its side effects).
# --------------------------------------------------------------------------- #
def _resolve_value_mapping(value_mappings: Any, legacy_value: str) -> Optional[str]:
    """Resolve a legacy value to its mapped new value (exact, then prefix)."""
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


def _model_rank(gm: GlobalMapping) -> Tuple[float, int]:
    try:
        ts = float(getattr(gm, "modified_at", None))
    except (TypeError, ValueError):
        ts = float("-inf")
    return (ts, int(getattr(gm, "id", 0) or 0))


def _build_latest_mapping_by_feature(rows: List[GlobalMapping]) -> Dict[str, GlobalMapping]:
    mapping_by_feature: Dict[str, GlobalMapping] = {}
    for gm in sorted(rows, key=_model_rank, reverse=True):
        for fid in (getattr(gm, "legacy_feature_ids", []) or []):
            norm = str(fid or "").strip()
            if norm and norm not in mapping_by_feature:
                mapping_by_feature[norm] = gm
    return mapping_by_feature


def _build_all_candidates_by_feature(rows: List[GlobalMapping]) -> Dict[str, List[str]]:
    candidates_by_feature: Dict[str, List[str]] = {}
    for gm in sorted(rows, key=_model_rank, reverse=True):
        target = (getattr(gm, "new_attribute_id", "") or "").strip()
        if not target:
            continue
        for fid in (getattr(gm, "legacy_feature_ids", []) or []):
            norm = str(fid or "").strip()
            if not norm:
                continue
            candidates_by_feature.setdefault(norm, [])
            if target not in candidates_by_feature[norm]:
                candidates_by_feature[norm].append(target)
    return candidates_by_feature


def _extract_existing_values(raw: Any) -> Set[str]:
    """Return the set of legacy values currently stored on a BomFeature."""
    if isinstance(raw, dict):
        vals = raw.get("values") or []
    elif isinstance(raw, list):
        vals = raw
    else:
        vals = []
    return {str(v).strip() for v in vals if str(v).strip()}


def _append_values(raw: Any, new_values: List[str]) -> Any:
    """Return an updated values container with ``new_values`` appended.

    Preserves the existing storage form (composite dict vs plain list).
    The caller is responsible for re-assigning the result so SQLAlchemy
    detects the change to the JSON column.
    """
    if isinstance(raw, dict):
        container = dict(raw)
        existing = list(container.get("values") or [])
        seen = {str(v).strip() for v in existing}
        for v in new_values:
            if v not in seen:
                existing.append(v)
                seen.add(v)
        container["values"] = existing
        return container
    # list or empty/None -> normalise to plain list
    existing = list(raw) if isinstance(raw, list) else []
    seen = {str(v).strip() for v in existing}
    for v in new_values:
        if v not in seen:
            existing.append(v)
            seen.add(v)
    return existing


# --------------------------------------------------------------------------- #
def load_csv(csv_path: Path) -> List[Tuple[str, str, str]]:
    """Read (item, feature, value) triples from the CSV."""
    rows: List[Tuple[str, str, str]] = []
    with csv_path.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        # Be tolerant of column-name casing / whitespace.
        field_map = {str(k).strip().lower(): k for k in (reader.fieldnames or [])}
        item_col = field_map.get("item")
        feature_col = field_map.get("feature")
        value_col = field_map.get("from value") or field_map.get("value")
        if not (item_col and feature_col and value_col):
            raise SystemExit(
                f"CSV must have columns Item, Feature, From Value. Found: {reader.fieldnames}"
            )
        for raw in reader:
            item = str(raw.get(item_col, "") or "").strip()
            feature = str(raw.get(feature_col, "") or "").strip()
            value = str(raw.get(value_col, "") or "").strip()
            if not item or not feature or value == "":
                continue
            rows.append((item, feature, value))
    return rows


def build_workspace_row(
    legacy_item_id: str,
    feature_id: str,
    legacy_value: str,
    mapping: Optional[GlobalMapping],
    candidates: List[str],
    feature_gm_status: Optional[str],
    feature_ignored_values: Set[str],
    feat_condition: Optional[str],
    feat_formula: Optional[str],
    now: float,
) -> Dict[str, Any]:
    """Compute a workspace_mappings row mirroring _run_mapping_generation_job."""
    if len(candidates) > 1:
        target_attr = ""
        candidates_json: Optional[List[str]] = candidates
    elif len(candidates) == 1:
        target_attr = candidates[0]
        candidates_json = candidates
    else:
        target_attr = ""
        candidates_json = None

    attr_type = (getattr(mapping, "attribute_type", "") or "").strip() if mapping else ""
    value_mappings = getattr(mapping, "value_mappings", {}) if mapping else {}

    # Per-value exclusion status. New values carry no till_date so they can
    # never be auto-"discontinued".
    val_status: Optional[str] = None
    if feature_gm_status:
        val_status = feature_gm_status
    elif legacy_value in feature_ignored_values:
        val_status = "ignored"

    if val_status:
        new_value = "NOT REQUIRED"
        mapped_from = "global"
    else:
        resolved = _resolve_value_mapping(value_mappings, legacy_value)
        new_value = resolved or ""
        mapped_from = "global" if resolved else ""

    return {
        "legacy_item_id": legacy_item_id,
        "legacy_feature_id": feature_id,
        "legacy_value": legacy_value,
        "new_attribute_id": target_attr,
        "new_value": new_value,
        "attribute_type": attr_type,
        "condition": feat_condition,
        "formula": feat_formula,
        "mapped_from": mapped_from,
        "value_status": val_status,
        "updated_at": now,
        "created_by": SCRIPT_TAG,
        "modified_by": SCRIPT_TAG,
        "modified_at": now,
        "candidate_attribute_ids_json": candidates_json,
    }


def run(csv_path: Path, dry_run: bool = False) -> None:
    connect_args = {}
    if settings.DATABASE_URL.startswith("sqlite"):
        connect_args = {"check_same_thread": False}
    engine = create_engine(settings.DATABASE_URL, connect_args=connect_args)
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()

    try:
        csv_rows = load_csv(csv_path)
        print(f"Loaded {len(csv_rows)} (item, feature, value) rows from {csv_path}")

        # Group values per (item, feature) preserving order, de-duplicating.
        grouped: Dict[Tuple[str, str], List[str]] = {}
        for item, feature, value in csv_rows:
            bucket = grouped.setdefault((item, feature), [])
            if value not in bucket:
                bucket.append(value)

        # --- Global mapping indexes (mirror generation job) ----------------- #
        gm_rows = session.query(GlobalMapping).all()
        mapping_by_feature = _build_latest_mapping_by_feature(gm_rows)
        candidates_by_feature = _build_all_candidates_by_feature(gm_rows)
        gm_status_by_feature: Dict[str, str] = {}
        gm_ignored_values_by_feature: Dict[str, Set[str]] = {}
        for gm in gm_rows:
            gm_status = (getattr(gm, "status", "active") or "active").strip().lower()
            gm_ignored = set(getattr(gm, "ignored_values", []) or [])
            for fid in (getattr(gm, "legacy_feature_ids", []) or []):
                nfid = str(fid or "").strip()
                if not nfid:
                    continue
                if gm_status != "active":
                    gm_status_by_feature[nfid] = gm_status
                if gm_ignored:
                    gm_ignored_values_by_feature.setdefault(nfid, set()).update(gm_ignored)

        # --- item_id -> bom_items.id lookup --------------------------------- #
        item_pk_by_id: Dict[str, int] = {
            iid: pk for iid, pk in session.query(BomItem.item_id, BomItem.id).all()
        }

        # --- Counters / reporting ------------------------------------------- #
        missing_items: Set[str] = set()
        features_created = 0
        values_added = 0
        values_already_present = 0
        ws_inserted = 0
        ws_skipped_existing = 0

        now = time.time()

        for (item_id, feature_id), values in grouped.items():
            item_pk = item_pk_by_id.get(item_id)
            if item_pk is None:
                missing_items.add(item_id)
                continue

            # 1. BomFeature: find existing or create.
            feat = (
                session.query(BomFeature)
                .filter(BomFeature.item_id == item_pk, BomFeature.feature_id == feature_id)
                .first()
            )
            if feat is None:
                feat = BomFeature(
                    item_id=item_pk,
                    feature_id=feature_id,
                    values=list(values),
                )
                if not dry_run:
                    session.add(feat)
                features_created += 1
                values_added += len(values)
                feat_condition = None
                feat_formula = None
            else:
                existing_vals = _extract_existing_values(feat.values)
                to_add = [v for v in values if v not in existing_vals]
                values_already_present += len(values) - len(to_add)
                if to_add:
                    feat.values = _append_values(feat.values, to_add)
                    values_added += len(to_add)
                feat_condition = (getattr(feat, "condition", "") or "").strip() or None
                feat_formula = (getattr(feat, "formula", "") or "").strip() or None

            # 2. WorkspaceMapping rows (insert-only).
            mapping = mapping_by_feature.get(feature_id)
            candidates = candidates_by_feature.get(feature_id, [])
            feature_gm_status = gm_status_by_feature.get(feature_id)
            feature_ignored_values = gm_ignored_values_by_feature.get(feature_id, set())

            for value in values:
                exists = (
                    session.query(WorkspaceMapping.id)
                    .filter(
                        WorkspaceMapping.legacy_item_id == item_id,
                        WorkspaceMapping.legacy_feature_id == feature_id,
                        WorkspaceMapping.legacy_value == value,
                    )
                    .first()
                )
                if exists:
                    ws_skipped_existing += 1
                    continue

                row = build_workspace_row(
                    legacy_item_id=item_id,
                    feature_id=feature_id,
                    legacy_value=value,
                    mapping=mapping,
                    candidates=candidates,
                    feature_gm_status=feature_gm_status,
                    feature_ignored_values=feature_ignored_values,
                    feat_condition=feat_condition,
                    feat_formula=feat_formula,
                    now=now,
                )
                if not dry_run:
                    session.add(WorkspaceMapping(**row))
                ws_inserted += 1

        if dry_run:
            session.rollback()
        else:
            session.commit()

        # --- Summary -------------------------------------------------------- #
        print()
        print("=" * 60)
        print("DRY RUN — no changes written" if dry_run else "Changes committed")
        print("=" * 60)
        print(f"  (item, feature) groups processed : {len(grouped)}")
        print(f"  BomFeature rows created          : {features_created}")
        print(f"  Legacy values added              : {values_added}")
        print(f"  Values already present (skipped) : {values_already_present}")
        print(f"  Workspace mappings inserted      : {ws_inserted}")
        print(f"  Workspace mappings skipped (existing): {ws_skipped_existing}")
        print(f"  Items not found in DB            : {len(missing_items)}")
        if missing_items:
            print("  Missing item IDs:")
            for iid in sorted(missing_items):
                print(f"    - {iid}")
    finally:
        session.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--csv",
        default=DEFAULT_CSV,
        help="Path to the 'missing from values' CSV (Item, Feature, From Value).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report counts without writing any changes.",
    )
    args = parser.parse_args()

    csv_path = Path(args.csv)
    if not csv_path.is_file():
        raise SystemExit(f"CSV not found: {csv_path}")

    run(csv_path, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
