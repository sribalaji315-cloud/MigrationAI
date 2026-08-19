"""Flip discontinued group_features rows to in_progress when they have no till_date.

Reads a CSV of (Feature, Option) pairs. For each matching group_features row
whose value_status == 'discontinued' AND till_date is blank/null, sets
value_status = 'in_progress'. Rows with a till_date are left untouched.

Usage:
    python revert_discontinued_no_till_date.py --dry-run "path/to/Discontinued list.csv"
    python revert_discontinued_no_till_date.py "path/to/Discontinued list.csv"

CSV format (header required):
    Feature,Option

Match keys: group_features.feature_id == Feature, group_features.option == Option
(both trimmed, exact match). All DB rows matching a key are considered.
"""

import argparse
import csv
import sys
from pathlib import Path
from typing import Optional, Set, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.db.models import GroupFeature
from app.db.session import SessionLocal

Key = Tuple[str, str]


def _trim(value: Optional[str]) -> str:
    return str(value or "").strip()


def _load_keys(csv_path: Path) -> Set[Key]:
    keys: Set[Key] = set()
    with csv_path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        headers = {h.strip() for h in (reader.fieldnames or [])}
        if "Feature" not in headers or "Option" not in headers:
            raise SystemExit(f"CSV must have 'Feature' and 'Option' headers; got {sorted(headers)}")
        for row in reader:
            feature = _trim(row.get("Feature"))
            option = _trim(row.get("Option"))
            if feature:
                keys.add((feature, option))
    return keys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path", help="Path to the CSV of Feature,Option pairs.")
    parser.add_argument("--dry-run", action="store_true", help="Report changes without writing.")
    args = parser.parse_args()

    csv_path = Path(args.csv_path)
    if not csv_path.is_file():
        raise SystemExit(f"CSV not found: {csv_path}")

    keys = _load_keys(csv_path)
    print(f"loaded {len(keys)} distinct (Feature, Option) keys from CSV")

    db = SessionLocal()
    try:
        rows = (
            db.query(GroupFeature)
            .filter(GroupFeature.value_status == "discontinued")
            .all()
        )

        updated = 0
        skipped_till_date = 0
        matched_keys: Set[Key] = set()
        for gf in rows:
            key = (_trim(gf.feature_id), _trim(gf.option))
            if key not in keys:
                continue
            matched_keys.add(key)
            if _trim(gf.till_date):
                skipped_till_date += 1
                continue
            if not args.dry_run:
                gf.value_status = "in_progress"
            updated += 1

        if not args.dry_run:
            db.commit()

        mode = "DRY RUN — no changes written" if args.dry_run else "Committed changes"
        print(mode)
        print(f"discontinued rows scanned: {len(rows)}")
        print(f"CSV keys matched in DB: {len(matched_keys)} / {len(keys)}")
        print(f"rows flipped to in_progress (no till_date): {updated}")
        print(f"rows skipped (has till_date): {skipped_till_date}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
