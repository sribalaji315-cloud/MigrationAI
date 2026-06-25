"""Update group feature target attributes from a CSV file.

Usage:
    python update_group_feature_target_attributes.py --dry-run "path/to/group feature attributes.csv"
    python update_group_feature_target_attributes.py "path/to/group feature attributes.csv"

CSV format (header required):
    FeatureGroup,Feature,Target Attribute_Tool

The CSV is treated as authoritative. Every database row matching the same
(FeatureGroup, Feature) pair is updated, regardless of option.
"""

import argparse
import csv
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# -- bootstrap SQLAlchemy without running the full FastAPI app --
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.db.models import GroupFeature
from app.db.session import SessionLocal


REQUIRED_HEADERS = {"FeatureGroup", "Feature", "Target Attribute_Tool"}
Key = Tuple[str, str]


def _trim(value: Optional[str]) -> str:
    return str(value or "").strip()


def _format_key(key: Key) -> str:
    return f"{key[0]} / {key[1]}"


def _print_samples(title: str, values: List[str], limit: int) -> None:
    if not values:
        return

    print(f"{title} ({len(values)}):")
    for value in values[:limit]:
        print(f"  - {value}")
    if len(values) > limit:
        print(f"  ... and {len(values) - limit} more")


def _load_csv(csv_path: Path) -> Tuple[Dict[Key, Optional[str]], int, int, List[str]]:
    mappings: Dict[Key, Optional[str]] = {}
    rows_scanned = 0
    skipped_rows = 0
    duplicate_keys: List[str] = []

    with open(csv_path, newline="", encoding="utf-8-sig") as file_handle:
        reader = csv.DictReader(file_handle)
        fieldnames = set(reader.fieldnames or [])
        missing_headers = sorted(REQUIRED_HEADERS - fieldnames)
        if missing_headers:
            print("CSV is missing required column(s): " + ", ".join(missing_headers))
            print(f"Found columns: {reader.fieldnames}")
            sys.exit(1)

        for row_number, row in enumerate(reader, start=2):
            rows_scanned += 1
            feature_group = _trim(row.get("FeatureGroup"))
            feature_id = _trim(row.get("Feature"))
            target_attribute = _trim(row.get("Target Attribute_Tool")) or None

            if not feature_group or not feature_id:
                skipped_rows += 1
                continue

            key = (feature_group, feature_id)
            if key in mappings:
                duplicate_keys.append(f"row {row_number}: {_format_key(key)}")
            mappings[key] = target_attribute

    return mappings, rows_scanned, skipped_rows, duplicate_keys


def update_target_attributes(csv_path: Path, dry_run: bool, preview_limit: int) -> int:
    if not csv_path.is_file():
        print(f"File not found: {csv_path}")
        return 1

    mappings, rows_scanned, skipped_rows, duplicate_keys = _load_csv(csv_path)

    db = SessionLocal()
    matched_rows = 0
    changed_rows = 0
    missing_keys: List[str] = []

    try:
        for key, target_attribute in mappings.items():
            feature_group, feature_id = key
            rows = (
                db.query(GroupFeature)
                .filter(
                    GroupFeature.feature_group == feature_group,
                    GroupFeature.feature_id == feature_id,
                )
                .all()
            )

            if not rows:
                missing_keys.append(_format_key(key))
                continue

            matched_rows += len(rows)
            for group_feature in rows:
                if group_feature.target_attribute != target_attribute:
                    changed_rows += 1
                if not dry_run:
                    group_feature.target_attribute = target_attribute

        if dry_run:
            db.rollback()
        else:
            db.commit()

        mode = "DRY RUN" if dry_run else "LIVE UPDATE"
        print(f"[{mode}] Group feature target attribute update complete.")
        print(f"CSV rows scanned: {rows_scanned}")
        print(f"CSV rows skipped: {skipped_rows}")
        print(f"Unique group/feature keys: {len(mappings)}")
        print(f"Duplicate CSV keys: {len(duplicate_keys)}")
        print(f"Matched database rows: {matched_rows}")
        print(f"Database rows changed: {changed_rows}")
        print(f"Missing group/feature keys: {len(missing_keys)}")

        _print_samples("Duplicate CSV keys; last row wins", duplicate_keys, preview_limit)
        _print_samples("Missing group/feature keys", missing_keys, preview_limit)
        return 0
    except Exception as error:
        db.rollback()
        print(f"Error: {error}")
        return 1
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Update group_features.target_attribute from a FeatureGroup/Feature CSV."
    )
    parser.add_argument("csv_file", help="Path to CSV with FeatureGroup, Feature, Target Attribute_Tool columns")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without committing them")
    parser.add_argument(
        "--preview-limit",
        type=int,
        default=20,
        help="Maximum duplicate or missing key samples to print",
    )
    args = parser.parse_args()

    exit_code = update_target_attributes(Path(args.csv_file), args.dry_run, max(args.preview_limit, 0))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()