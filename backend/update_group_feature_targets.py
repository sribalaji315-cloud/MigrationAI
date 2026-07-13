"""Update group feature target attributes and target values from a CSV file.

Usage:
    python update_group_feature_targets.py --dry-run "path/to/group feature update.csv"
    python update_group_feature_targets.py "path/to/group feature update.csv"

CSV format (header required):
    FeatureGroup,Feature,Option,Target Attribute,Target Value
    (extra columns such as WhereUsed / Feature Desc / Option Desc are ignored)

The CSV is authoritative per (FeatureGroup, Feature, Option) key. Every database
row matching the same key has its target_attribute and target_value overwritten
with the CSV values. Database rows whose key is absent from the CSV are left
untouched.

Option matching is exact first. If an exact option is not found, a leading-zero
fallback is attempted (e.g. CSV "2" matches DB "02", CSV "2001" matches DB
"02001"). The fallback is only applied when it resolves to exactly one distinct
database option for that (FeatureGroup, Feature); ambiguous cases are reported
and skipped.
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


REQUIRED_HEADERS = {"FeatureGroup", "Feature", "Option", "Target Attribute", "Target Value"}
Key = Tuple[str, str, str]
Target = Tuple[Optional[str], Optional[str]]


def _trim(value: Optional[str]) -> str:
    return str(value or "").strip()


def _norm_option(option: str) -> str:
    """Normalize an option for leading-zero-insensitive comparison."""
    stripped = option.strip().lstrip("0")
    return stripped if stripped else "0"


def _format_key(key: Key) -> str:
    return f"{key[0]} / {key[1]} / {key[2]}"


def _print_samples(title: str, values: List[str], limit: int) -> None:
    if not values:
        return

    print(f"{title} ({len(values)}):")
    for value in values[:limit]:
        print(f"  - {value}")
    if len(values) > limit:
        print(f"  ... and {len(values) - limit} more")


def _load_csv(
    csv_path: Path,
) -> Tuple[Dict[Key, Target], int, int, List[str]]:
    mappings: Dict[Key, Target] = {}
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
            option = _trim(row.get("Option"))
            target_attribute = _trim(row.get("Target Attribute")) or None
            target_value = _trim(row.get("Target Value")) or None

            if not feature_group or not feature_id:
                skipped_rows += 1
                continue

            key = (feature_group, feature_id, option)
            if key in mappings:
                duplicate_keys.append(f"row {row_number}: {_format_key(key)}")
            mappings[key] = (target_attribute, target_value)

    return mappings, rows_scanned, skipped_rows, duplicate_keys


def _resolve_targets(
    db, mappings: Dict[Key, Target]
) -> Tuple[Dict[int, Target], int, int, List[str], List[str]]:
    """Map each database row id to the CSV target it should receive.

    Returns (row_targets, exact_matches, fallback_matches, unmatched_keys,
    ambiguous_keys).
    """
    # Index CSV mappings for exact and leading-zero fallback lookups.
    exact: Dict[Key, Target] = dict(mappings)
    by_norm: Dict[Tuple[str, str, str], Dict[str, Target]] = {}
    for (group, feature, option), target in mappings.items():
        norm_bucket = by_norm.setdefault((group, feature, _norm_option(option)), {})
        norm_bucket[option] = target

    row_targets: Dict[int, Target] = {}
    matched_keys_exact = set()
    matched_keys_fallback = set()

    rows = db.query(GroupFeature).all()
    for gf in rows:
        group = _trim(gf.feature_group)
        feature = _trim(gf.feature_id)
        option = _trim(gf.option)

        key = (group, feature, option)
        if key in exact:
            row_targets[gf.id] = exact[key]
            matched_keys_exact.add(key)
            continue

        norm_bucket = by_norm.get((group, feature, _norm_option(option)))
        if norm_bucket and len(norm_bucket) == 1:
            (csv_option, target), = norm_bucket.items()
            row_targets[gf.id] = target
            matched_keys_fallback.add((group, feature, csv_option))

    # Determine which CSV keys never matched any database row.
    matched_keys = matched_keys_exact | matched_keys_fallback
    unmatched_keys: List[str] = []
    ambiguous_keys: List[str] = []
    for key in mappings:
        group, feature, option = key
        if key in matched_keys:
            continue
        norm_bucket = by_norm.get((group, feature, _norm_option(option)))
        if norm_bucket and len(norm_bucket) > 1:
            ambiguous_keys.append(_format_key(key))
        else:
            unmatched_keys.append(_format_key(key))

    return (
        row_targets,
        len(matched_keys_exact),
        len(matched_keys_fallback),
        unmatched_keys,
        ambiguous_keys,
    )


def update_targets(csv_path: Path, dry_run: bool, preview_limit: int) -> int:
    if not csv_path.is_file():
        print(f"File not found: {csv_path}")
        return 1

    mappings, rows_scanned, skipped_rows, duplicate_keys = _load_csv(csv_path)

    db = SessionLocal()
    changed_rows = 0

    try:
        (
            row_targets,
            exact_matches,
            fallback_matches,
            unmatched_keys,
            ambiguous_keys,
        ) = _resolve_targets(db, mappings)

        matched_rows = len(row_targets)
        for gf in db.query(GroupFeature).all():
            if gf.id not in row_targets:
                continue
            target_attribute, target_value = row_targets[gf.id]
            if (
                gf.target_attribute != target_attribute
                or gf.target_value != target_value
            ):
                changed_rows += 1
            if not dry_run:
                gf.target_attribute = target_attribute
                gf.target_value = target_value

        if dry_run:
            db.rollback()
        else:
            db.commit()

        mode = "DRY RUN" if dry_run else "LIVE UPDATE"
        print(f"[{mode}] Group feature target update complete.")
        print(f"CSV rows scanned: {rows_scanned}")
        print(f"CSV rows skipped (missing group/feature): {skipped_rows}")
        print(f"Unique group/feature/option keys: {len(mappings)}")
        print(f"Duplicate CSV keys: {len(duplicate_keys)}")
        print(f"CSV keys matched exactly: {exact_matches}")
        print(f"CSV keys matched via leading-zero fallback: {fallback_matches}")
        print(f"Matched database rows: {matched_rows}")
        print(f"Database rows changed: {changed_rows}")
        print(f"Unmatched CSV keys: {len(unmatched_keys)}")
        print(f"Ambiguous CSV keys (skipped): {len(ambiguous_keys)}")

        _print_samples("Duplicate CSV keys; last row wins", duplicate_keys, preview_limit)
        _print_samples("Ambiguous CSV keys (skipped)", ambiguous_keys, preview_limit)
        _print_samples("Unmatched CSV keys", unmatched_keys, preview_limit)
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
            "Update group_features.target_attribute and target_value from a "
            "FeatureGroup/Feature/Option CSV."
        )
    )
    parser.add_argument(
        "csv_file",
        help="Path to CSV with FeatureGroup, Feature, Option, Target Attribute, Target Value columns",
    )
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without committing them")
    parser.add_argument(
        "--preview-limit",
        type=int,
        default=20,
        help="Maximum duplicate/unmatched/ambiguous key samples to print",
    )
    args = parser.parse_args()

    exit_code = update_targets(Path(args.csv_file), args.dry_run, max(args.preview_limit, 0))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
