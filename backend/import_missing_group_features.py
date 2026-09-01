"""Insert group_features rows that are missing for entirely-absent options.

Reads a group-features CSV export and inserts a row for every CSV row whose
``(feature_group, feature_id, option)`` combination does NOT yet exist in the
``group_features`` table. Options that already exist (in any period/condition
variant) are left untouched, so this only fills genuinely-missing options.

Column mapping mirrors the ``/group-features/upload`` endpoint:
    FeatureGroup -> feature_group
    Feature      -> feature_id
    Feature Desc -> feature_desc
    Option       -> option
    Option Desc  -> option_desc
    Condition    -> condition
    Till         -> till_date  (present => value_status='discontinued')

Usage (run from backend/ with the repo venv):
    python import_missing_group_features.py --csv "<path.csv>" [--dry-run]

Defaults to a dry run unless --commit is passed.
"""

from __future__ import annotations

import argparse
import csv
import time
from pathlib import Path
from typing import Dict, List, Set, Tuple

from app.db.models import GroupFeature
from app.db.session import SessionLocal


def _clean(value: str | None) -> str:
    return (value or "").strip()


def load_csv_rows(csv_path: Path) -> List[Dict[str, str]]:
    with csv_path.open(newline="", encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def build_row(csv_row: Dict[str, str], now_ts: float, created_by: str) -> Dict[str, object]:
    till_date = _clean(csv_row.get("Till"))
    value_status = "discontinued" if till_date else "in_progress"
    return {
        "feature_group": _clean(csv_row.get("FeatureGroup")),
        "feature_id": _clean(csv_row.get("Feature")),
        "feature_desc": _clean(csv_row.get("Feature Desc")) or None,
        "option": _clean(csv_row.get("Option")),
        "option_desc": _clean(csv_row.get("Option Desc")) or None,
        "condition": _clean(csv_row.get("Condition")) or None,
        "till_date": till_date or None,
        "target_attribute": None,
        "target_value": None,
        "value_status": value_status,
        "valuelist_id": None,
        "created_by": created_by,
        "created_at": now_ts,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", required=True, help="Path to the group-features CSV export.")
    parser.add_argument("--commit", action="store_true", help="Persist changes (otherwise dry run).")
    parser.add_argument("--dry-run", action="store_true", help="Preview only; make no changes.")
    parser.add_argument("--created-by", default="import_missing_group_features")
    args = parser.parse_args()

    dry_run = args.dry_run or not args.commit
    csv_path = Path(args.csv)
    if not csv_path.exists():
        raise SystemExit(f"CSV not found: {csv_path}")

    rows = load_csv_rows(csv_path)
    now_ts = time.time()

    db = SessionLocal()
    try:
        existing: Set[Tuple[str, str, str]] = set()
        for fg, fid, opt in db.query(
            GroupFeature.feature_group, GroupFeature.feature_id, GroupFeature.option
        ).all():
            existing.add((fg or "", fid or "", opt or ""))

        to_insert: List[Dict[str, object]] = []
        seen_new: Set[Tuple[str, str, str]] = set()
        skipped_no_key = 0

        for csv_row in rows:
            fg = _clean(csv_row.get("FeatureGroup"))
            fid = _clean(csv_row.get("Feature"))
            opt = _clean(csv_row.get("Option"))
            if not fg or not fid:
                skipped_no_key += 1
                continue
            key = (fg, fid, opt)
            if key in existing:
                continue
            to_insert.append(build_row(csv_row, now_ts, args.created_by))
            seen_new.add(key)

        print(f"CSV rows read:               {len(rows)}")
        print(f"Existing group_features keys: {len(existing)}")
        print(f"Rows skipped (no group/feat): {skipped_no_key}")
        print(f"Missing options to insert:    {len(to_insert)} rows ({len(seen_new)} distinct options)")

        if to_insert:
            print("\nSample of rows to insert:")
            for r in to_insert[:20]:
                print(
                    f"  {r['feature_group']}/{r['feature_id']}/{r['option']}"
                    f"  status={r['value_status']}  till={r['till_date'] or ''}"
                    f"  desc={r['option_desc'] or ''}"
                )

        if dry_run:
            print("\nDRY RUN — no changes written. Re-run with --commit to insert.")
            return

        if to_insert:
            db.bulk_insert_mappings(GroupFeature, to_insert)
            db.commit()
        print(f"\nInserted {len(to_insert)} group_features rows.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
