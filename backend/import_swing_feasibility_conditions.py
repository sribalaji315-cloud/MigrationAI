"""
Import feasibility + condition from a source SQLite ``SwingExpansionValues``
table into the application's ``workspace_mappings`` table.

This is an UPDATE-EXISTING-ONLY flow: each source value row is matched to a
single ``WorkspaceMapping`` by the natural key
``(legacy_item_id, legacy_feature_id, legacy_value)`` and only the
``feasibility`` and ``condition`` columns are written. Rows with no matching
workspace mapping are skipped (nothing is inserted).

Matching:
    legacy_item_id    <- SwingExpansions.ITEM     (joined via SwingExpansionId -> Id)
    legacy_feature_id <- SwingExpansionValues.Feature
    legacy_value      <- SwingExpansionValues.Option

Written:
    feasibility <- feasible enum mapped to a label (1=Yes, 2=No, 3=Review, 4=Conditional)
    condition   <- Condition (only set when source value is non-empty)

Usage:
    cd backend
    python import_swing_feasibility_conditions.py --config import_config_swing_feasibility.json --dry-run
    python import_swing_feasibility_conditions.py --config import_config_swing_feasibility.json
"""

import argparse
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Ensure the backend package is importable when running from <repo>/backend/
# ---------------------------------------------------------------------------
_BACKEND_ROOT = Path(__file__).resolve().parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from sqlalchemy import create_engine, text

from app.core.config import settings
from import_from_sqlite import _load_config, _open_source_db

_SAMPLE_LIMIT = 20  # max example rows printed in dry-run


def _normalize_text(value: Any) -> Optional[str]:
    """Trim a source value to text, returning None for empty/missing."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _table_columns(src: sqlite3.Connection, table: str) -> list[str]:
    """Return the column names of *table* in the source database."""
    rows = src.execute(f"PRAGMA table_info([{table}])").fetchall()
    return [r["name"] for r in rows]


def _require_columns(src: sqlite3.Connection, table: str, required: list[str]) -> None:
    """Exit with a helpful message if any *required* column is missing.

    SQLite column access is case-insensitive, so the check is too.
    """
    available = _table_columns(src, table)
    available_lower = {c.lower() for c in available}
    missing = [c for c in required if c and c.lower() not in available_lower]
    if missing:
        sys.exit(
            f"ERROR: Table [{table}] is missing column(s): {missing}.\n"
            f"       Available columns: {available}"
        )


def _map_feasible(raw: Any, enum_map: dict) -> Optional[str]:
    """Map a raw ``feasible`` enum code to its label using *enum_map*.

    Returns ``None`` when the value is empty or unknown so existing data is
    left untouched rather than overwritten with a blank.
    """
    text = _normalize_text(raw)
    if text is None:
        return None
    # Source may store the code as int (1) or text ("1"); normalize numeric
    # codes so "1" and "1.0" both resolve.
    key = text
    try:
        key = str(int(float(text)))
    except (TypeError, ValueError):
        pass
    return enum_map.get(key) or enum_map.get(text)


def run_import(cfg: dict, *, dry_run: bool = False) -> None:
    parent_table = cfg["parent_table"]
    parent_pk = cfg["parent_pk_column"]
    parent_item_col = cfg["parent_item_column"]

    child_table = cfg["child_table"]
    child_fk = cfg["child_fk_column"]
    child_feature_col = cfg["child_feature_column"]
    child_value_col = cfg["child_value_column"]
    child_feasible_col = cfg.get("child_feasible_column")
    child_condition_col = cfg.get("child_condition_column")

    enum_map = {str(k): v for k, v in (cfg.get("feasible_enum_map") or {}).items()}
    preserve_condition_when_empty = bool(cfg.get("preserve_condition_when_empty", True))

    # ---- source database: build an in-memory index ----------------------
    # key = (legacy_item_id, legacy_feature_id, legacy_value)
    # val = (feasibility_label_or_None, condition_or_None)
    src = _open_source_db(cfg["source_db_path"])
    source_index: dict[tuple[str, str, str], tuple[Optional[str], Optional[str]]] = {}
    skipped = 0
    try:
        _require_columns(src, parent_table, [parent_pk, parent_item_col])
        child_required = [child_fk, child_feature_col, child_value_col]
        if child_feasible_col:
            child_required.append(child_feasible_col)
        if child_condition_col:
            child_required.append(child_condition_col)
        _require_columns(src, child_table, child_required)

        feasible_select = (
            f"c.[{child_feasible_col}] AS feasible" if child_feasible_col else "NULL AS feasible"
        )
        condition_select = (
            f"c.[{child_condition_col}] AS cond" if child_condition_col else "NULL AS cond"
        )
        query = (
            f"SELECT p.[{parent_item_col}] AS item, "
            f"c.[{child_feature_col}] AS feature, "
            f"c.[{child_value_col}] AS value, "
            f"{feasible_select}, {condition_select} "
            f"FROM [{child_table}] c "
            f"JOIN [{parent_table}] p ON p.[{parent_pk}] = c.[{child_fk}]"
        )
        cursor = src.execute(query)
        source_rows = 0
        while True:
            batch = cursor.fetchmany(50000)
            if not batch:
                break
            for row in batch:
                source_rows += 1
                item = _normalize_text(row["item"])
                feature = _normalize_text(row["feature"])
                value = _normalize_text(row["value"])
                if not item or not feature or value is None:
                    skipped += 1
                    continue
                feasibility = _map_feasible(row["feasible"], enum_map)
                condition = _normalize_text(row["cond"])
                source_index[(item, feature, value)] = (feasibility, condition)
        print(f"Source: {source_rows} rows in [{child_table}] (joined to [{parent_table}])")
        print(f"Source: {len(source_index)} distinct (item, feature, value) keys")
    finally:
        src.close()

    # ---- target database -------------------------------------------------
    connect_args = {}
    if settings.DATABASE_URL.startswith("sqlite"):
        connect_args = {"check_same_thread": False}
    engine = create_engine(settings.DATABASE_URL, connect_args=connect_args)

    now = time.time()
    matched = 0
    updated = 0
    unchanged = 0
    samples_printed = 0
    pending: list[dict] = []
    seen_keys: set[tuple[str, str, str]] = set()

    update_sql = text(
        "UPDATE workspace_mappings "
        "SET feasibility = :feasibility, condition = :condition, "
        "updated_at = :now, modified_at = :now, "
        "modified_by = 'import_swing_feasibility', version = version + 1 "
        "WHERE id = :id"
    )

    select_sql = text(
        "SELECT id, legacy_item_id, legacy_feature_id, legacy_value, "
        "feasibility, condition FROM workspace_mappings"
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
                row.legacy_value if row.legacy_value is not None else None,
            )
            src_entry = source_index.get(key)
            if src_entry is None:
                continue

            matched += 1
            seen_keys.add(key)
            src_feasibility, src_condition = src_entry

            new_feasibility = row.feasibility
            if src_feasibility is not None:
                new_feasibility = src_feasibility

            new_condition = row.condition
            if src_condition is not None:
                new_condition = src_condition
            elif not preserve_condition_when_empty:
                new_condition = None

            if new_feasibility == row.feasibility and new_condition == row.condition:
                unchanged += 1
                continue

            updated += 1
            if dry_run:
                if samples_printed < _SAMPLE_LIMIT:
                    changes = []
                    if new_feasibility != row.feasibility:
                        changes.append(f"feasibility={new_feasibility!r}")
                    if new_condition != row.condition:
                        changes.append(f"condition={new_condition!r}")
                    print(
                        f"  [DRY-RUN] id={row.id} item={key[0]!r} "
                        f"feature={key[1]!r} value={key[2]!r} <- {', '.join(changes)}"
                    )
                    samples_printed += 1
                continue

            pending.append(
                {
                    "id": row.id,
                    "feasibility": new_feasibility,
                    "condition": new_condition,
                    "now": now,
                }
            )
            if len(pending) >= 5000:
                _flush()

        _flush()

    not_found = len(source_index) - len(seen_keys)

    if dry_run:
        if updated > _SAMPLE_LIMIT:
            print(f"  ... ({updated - _SAMPLE_LIMIT} more changes not shown)")
        print("\n[DRY-RUN] No data was written.")
    else:
        print("\nCommitted successfully.")

    print(f"Matched:   {matched} (workspace_mappings rows with a source key)")
    print(f"Updated:   {updated}")
    print(f"Unchanged: {unchanged}")
    print(f"Not found: {not_found} (source keys with no workspace_mappings row)")
    if skipped:
        print(f"Skipped:   {skipped} (source rows missing item/feature/value)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="Path to JSON config file.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without writing to the database.",
    )
    args = parser.parse_args()

    cfg = _load_config(args.config)
    run_import(cfg, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
