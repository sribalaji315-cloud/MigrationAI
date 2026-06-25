"""
Update workspace mapping attribute types from a CSV file.

This is an UPDATE-EXISTING-ONLY flow. Each CSV row is matched to one
``workspace_mappings`` row by the natural key
``(legacy_item_id, legacy_feature_id, legacy_value)`` and only the
``attribute_type`` column is written, along with audit/version metadata.

Expected CSV columns:
    legacy_item_id, legacy_feature_id, legacy_value, attribute types

The attribute type column also accepts these aliases for convenience:
    attribute_type, attribute_types

Usage:
    cd backend
    python update_workspace_attribute_types.py --csv path/to/data.csv --dry-run
    python update_workspace_attribute_types.py --csv path/to/data.csv
"""

import argparse
import csv
import sys
import time
from pathlib import Path
from typing import Any, Optional

_BACKEND_ROOT = Path(__file__).resolve().parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from sqlalchemy import create_engine, text

from app.core.config import settings

_ATTRIBUTE_TYPE_COLUMNS = ("attribute types", "attribute_type", "attribute_types")
_SCRIPT_NAME = "update_workspace_attribute_types"
_SAMPLE_LIMIT = 25


def _normalize_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _normalized_headers(fieldnames: list[str] | None) -> dict[str, str]:
    if not fieldnames:
        return {}
    return {name.strip().lower(): name for name in fieldnames if name is not None}


def _column_name(headers: dict[str, str], aliases: tuple[str, ...]) -> Optional[str]:
    for alias in aliases:
        found = headers.get(alias.lower())
        if found:
            return found
    return None


def _read_csv(csv_path: Path) -> tuple[dict[tuple[str, str, str], str], int, int]:
    if not csv_path.exists():
        sys.exit(f"ERROR: CSV file does not exist: {csv_path}")

    source_index: dict[tuple[str, str, str], str] = {}
    duplicate_same_value = 0
    conflicts: list[str] = []

    with csv_path.open("r", newline="", encoding="utf-8-sig") as csv_file:
        reader = csv.DictReader(csv_file)
        headers = _normalized_headers(reader.fieldnames)

        item_col = _column_name(headers, ("legacy_item_id",))
        feature_col = _column_name(headers, ("legacy_feature_id",))
        value_col = _column_name(headers, ("legacy_value",))
        attribute_type_col = _column_name(headers, _ATTRIBUTE_TYPE_COLUMNS)

        missing_columns = []
        if not item_col:
            missing_columns.append("legacy_item_id")
        if not feature_col:
            missing_columns.append("legacy_feature_id")
        if not value_col:
            missing_columns.append("legacy_value")
        if not attribute_type_col:
            missing_columns.append("attribute types")
        if missing_columns:
            available = reader.fieldnames or []
            sys.exit(
                f"ERROR: CSV is missing required column(s): {missing_columns}.\n"
                f"       Available columns: {available}"
            )

        total_rows = 0
        for line_number, row in enumerate(reader, start=2):
            total_rows += 1
            item_id = _normalize_text(row.get(item_col))
            feature_id = _normalize_text(row.get(feature_col))
            legacy_value = _normalize_text(row.get(value_col))
            attribute_type = _normalize_text(row.get(attribute_type_col))

            missing_fields = []
            if not item_id:
                missing_fields.append("legacy_item_id")
            if not feature_id:
                missing_fields.append("legacy_feature_id")
            if legacy_value is None:
                missing_fields.append("legacy_value")
            if not attribute_type:
                missing_fields.append(attribute_type_col)
            if missing_fields:
                sys.exit(
                    f"ERROR: CSV line {line_number} is missing required field(s): "
                    f"{missing_fields}"
                )

            key = (item_id, feature_id, legacy_value)
            existing_attribute_type = source_index.get(key)
            if existing_attribute_type is None:
                source_index[key] = attribute_type
            elif existing_attribute_type == attribute_type:
                duplicate_same_value += 1
            else:
                conflicts.append(
                    f"line {line_number}: key={key!r} has both "
                    f"{existing_attribute_type!r} and {attribute_type!r}"
                )

    if conflicts:
        print("ERROR: Conflicting duplicate CSV keys were found:")
        for conflict in conflicts[:_SAMPLE_LIMIT]:
            print(f"  - {conflict}")
        if len(conflicts) > _SAMPLE_LIMIT:
            print(f"  ... and {len(conflicts) - _SAMPLE_LIMIT} more")
        sys.exit(1)

    return source_index, total_rows, duplicate_same_value


def run_import(csv_path: Path, *, dry_run: bool = False) -> None:
    source_index, total_rows, duplicate_same_value = _read_csv(csv_path)

    connect_args = {}
    if settings.DATABASE_URL.startswith("sqlite"):
        connect_args = {"check_same_thread": False}
    engine = create_engine(settings.DATABASE_URL, connect_args=connect_args)

    now = time.time()
    matched = 0
    updated = 0
    unchanged = 0
    samples_printed = 0
    pending: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str, str]] = set()
    missing_samples: list[tuple[str, str, str]] = []

    update_sql = text(
        "UPDATE workspace_mappings "
        "SET attribute_type = :attribute_type, "
        "updated_at = :now, modified_at = :now, "
        "modified_by = :modified_by, version = version + 1 "
        "WHERE id = :id"
    )

    select_sql = text(
        "SELECT id, legacy_item_id, legacy_feature_id, legacy_value, attribute_type "
        "FROM workspace_mappings"
    )

    with engine.connect() as conn:
        def _flush() -> None:
            if pending and not dry_run:
                conn.execute(update_sql, pending)
                conn.commit()
            pending.clear()

        result = conn.execution_options(stream_results=True).execute(select_sql)
        for row in result:
            key = (
                _normalize_text(row.legacy_item_id),
                _normalize_text(row.legacy_feature_id),
                row.legacy_value if row.legacy_value is not None else "",
            )
            target_attribute_type = source_index.get(key)
            if target_attribute_type is None:
                continue

            matched += 1
            seen_keys.add(key)

            if target_attribute_type == row.attribute_type:
                unchanged += 1
                continue

            updated += 1
            if dry_run:
                if samples_printed < _SAMPLE_LIMIT:
                    print(
                        f"  [DRY-RUN] id={row.id} item={key[0]!r} "
                        f"feature={key[1]!r} value={key[2]!r} "
                        f"attribute_type: {row.attribute_type!r} -> "
                        f"{target_attribute_type!r}"
                    )
                    samples_printed += 1
                continue

            pending.append(
                {
                    "id": row.id,
                    "attribute_type": target_attribute_type,
                    "now": now,
                    "modified_by": _SCRIPT_NAME,
                }
            )
            if len(pending) >= 5000:
                _flush()

        _flush()

    missing_keys = [key for key in source_index if key not in seen_keys]
    missing_samples = missing_keys[:_SAMPLE_LIMIT]

    print(f"CSV rows:       {total_rows}")
    print(f"Distinct keys:  {len(source_index)}")
    print(f"Duplicate keys: {duplicate_same_value} (same attribute type, ignored)")
    print(f"Matched:        {matched}")
    print(f"Updated:        {updated}")
    print(f"Unchanged:      {unchanged}")
    print(f"Not found:      {len(missing_keys)}")

    if updated > _SAMPLE_LIMIT and dry_run:
        print(f"  ... ({updated - _SAMPLE_LIMIT} more changes not shown)")
    if missing_samples:
        print("Missing keys:")
        for key in missing_samples:
            print(f"  - item={key[0]!r} feature={key[1]!r} value={key[2]!r}")
        if len(missing_keys) > _SAMPLE_LIMIT:
            print(f"  ... and {len(missing_keys) - _SAMPLE_LIMIT} more")

    if dry_run:
        print("\n[DRY-RUN] No data was written.")
    else:
        print("\nCommitted successfully.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "csv_path",
        nargs="?",
        type=Path,
        help="Path to the CSV file. May also be provided with --csv.",
    )
    parser.add_argument("--csv", dest="csv_option", type=Path, help="Path to the CSV file.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without writing to the database.",
    )
    args = parser.parse_args()

    csv_path = args.csv_option or args.csv_path
    if csv_path is None:
        parser.error("a CSV path is required")

    run_import(csv_path, dry_run=args.dry_run)


if __name__ == "__main__":
    main()