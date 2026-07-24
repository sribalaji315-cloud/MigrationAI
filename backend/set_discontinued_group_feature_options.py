"""One-time cleanup: mark group feature options as discontinued from CSV.

Reads a CSV whose first/header column is ``Option`` and sets
``group_features.value_status`` to ``discontinued`` for every database row
whose ``option`` exactly matches one of those CSV values.

Usage:
    cd backend
    python set_discontinued_group_feature_options.py --dry-run "path/to/options.csv"
    python set_discontinued_group_feature_options.py "path/to/options.csv"
"""

import argparse
import csv
import sys
from pathlib import Path
from typing import List, Set, Tuple

_BACKEND_ROOT = Path(__file__).resolve().parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.db.models import GroupFeature
from app.db.session import SessionLocal


TARGET_STATUS = "discontinued"
REQUIRED_HEADER = "Option"


def _trim(value) -> str:
    return str(value or "").strip()


def _print_samples(title: str, rows: List[GroupFeature], limit: int) -> None:
    if not rows or limit <= 0:
        return

    print(f"{title} ({len(rows)}):")
    for row in rows[:limit]:
        print(
            f"  - id={row.id} group={row.feature_group} "
            f"feature={row.feature_id} option='{row.option}' "
            f"status='{row.value_status}'"
        )
    if len(rows) > limit:
        print(f"  ... and {len(rows) - limit} more")


def _load_options(csv_path: Path) -> Tuple[Set[str], int, int, int]:
    options: Set[str] = set()
    rows_scanned = 0
    skipped_rows = 0
    duplicate_options = 0

    with open(csv_path, newline="", encoding="utf-8-sig") as file_handle:
        reader = csv.DictReader(file_handle)
        fieldnames = reader.fieldnames or []
        if REQUIRED_HEADER not in fieldnames:
            print(f"CSV is missing required column: {REQUIRED_HEADER}")
            print(f"Found columns: {fieldnames}")
            sys.exit(1)

        for row in reader:
            rows_scanned += 1
            option = _trim(row.get(REQUIRED_HEADER))
            if not option:
                skipped_rows += 1
                continue
            if option in options:
                duplicate_options += 1
            options.add(option)

    return options, rows_scanned, skipped_rows, duplicate_options


def mark_discontinued(csv_path: Path, dry_run: bool, preview_limit: int) -> int:
    if not csv_path.is_file():
        print(f"File not found: {csv_path}")
        return 1

    options, rows_scanned, skipped_rows, duplicate_options = _load_options(csv_path)
    db = SessionLocal()

    try:
        rows = (
            db.query(GroupFeature)
            .filter(
                GroupFeature.option.in_(options),
                GroupFeature.value_status != TARGET_STATUS,
            )
            .order_by(GroupFeature.feature_group, GroupFeature.feature_id, GroupFeature.option, GroupFeature.id)
            .all()
            if options
            else []
        )

        already_discontinued = (
            db.query(GroupFeature)
            .filter(
                GroupFeature.option.in_(options),
                GroupFeature.value_status == TARGET_STATUS,
            )
            .count()
            if options
            else 0
        )

        if not dry_run:
            for row in rows:
                row.value_status = TARGET_STATUS
            db.commit()
        else:
            db.rollback()

        mode = "DRY RUN" if dry_run else "LIVE UPDATE"
        print(f"[{mode}] Group feature option discontinuation complete.")
        print(f"CSV rows scanned: {rows_scanned}")
        print(f"CSV rows skipped (blank option): {skipped_rows}")
        print(f"Unique options loaded: {len(options)}")
        print(f"Duplicate CSV options: {duplicate_options}")
        print(f"Matching rows already discontinued: {already_discontinued}")
        print(f"Database rows changed: {len(rows)}")
        _print_samples("Rows matched for update", rows, preview_limit)
        if dry_run:
            print("Dry run - no changes written.")
        return 0
    except Exception as error:
        db.rollback()
        print(f"Error: {error}")
        return 1
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Set group_features.value_status='discontinued' for every row "
            "whose option exactly matches the Option column in a CSV."
        )
    )
    parser.add_argument("csv_file", help="Path to CSV with an Option column")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without committing them")
    parser.add_argument(
        "--preview-limit",
        type=int,
        default=20,
        help="Maximum matched row samples to print",
    )
    args = parser.parse_args()

    exit_code = mark_discontinued(Path(args.csv_file), args.dry_run, max(args.preview_limit, 0))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()