"""
Import data from an external SQLite database into the application's
bom_items + bom_features tables, using a JSON config file for field-name mapping.

Usage:
    cd backend
    python import_from_sqlite.py --config import_config.json
    python import_from_sqlite.py --config import_config.json --dry-run
    python import_from_sqlite.py --config import_config.json --force
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Ensure the backend package is importable when running from <repo>/backend/
# ---------------------------------------------------------------------------
_BACKEND_ROOT = Path(__file__).resolve().parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.db.models import BomItem, BomFeature
from app.db.session import Base


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_config(config_path: str) -> dict:
    path = Path(config_path)
    if not path.exists():
        sys.exit(f"ERROR: Config file not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _open_source_db(db_path: str) -> sqlite3.Connection:
    """Open source SQLite in read-only mode."""
    path = Path(db_path)
    if not path.exists():
        sys.exit(f"ERROR: Source database not found: {path}")
    uri = f"file:{path.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _map_row(row: sqlite3.Row, mapping: dict) -> dict:
    """Apply a column mapping to a source row.

    *mapping* is ``{target_field: source_column}``.
    Missing source columns are silently set to ``None``.
    """
    result = {}
    for target_field, source_column in mapping.items():
        try:
            result[target_field] = row[source_column]
        except (IndexError, KeyError):
            result[target_field] = None
    return result


def _collect_values(row: sqlite3.Row, columns: list) -> list:
    """Gather values from multiple source columns into a JSON-ready list.

    ``None`` and empty-string values are skipped.
    """
    vals = []
    for col in columns:
        try:
            v = row[col]
        except (IndexError, KeyError):
            continue
        if v is not None and v != "":
            vals.append(v)
    return vals


def _build_values_payload(row: sqlite3.Row, vals: list | None, desc_col: str | None):
    """Build the values payload for BomFeature.values JSON column.

    When *desc_col* is set, returns the composite dict format that the app
    already understands::

        {"values": ["v1", "v2"], "valueDescriptions": {"v1": "desc1"}}

    Otherwise returns the plain list ``["v1", "v2"]``.
    """
    if vals is None:
        return None

    if not desc_col:
        return vals

    # Read the description from the source row
    try:
        desc = row[desc_col]
    except (IndexError, KeyError):
        desc = None

    value_descriptions: dict[str, str] = {}
    if desc is not None and desc != "":
        for v in vals:
            value_descriptions[str(v)] = str(desc)

    if value_descriptions:
        return {"values": vals, "valueDescriptions": value_descriptions}
    return vals


def _group_children_by_feature(
    child_rows: list,
    child_mapping: dict,
    values_cols: list,
    value_desc_col: str | None,
    till_date_col: str | None = None,
) -> list[dict]:
    """Group child rows by feature_id, aggregating values and descriptions.

    Multiple child rows with the same feature_id are merged into a single
    feature dict with combined values list and valueDescriptions dict.
    """
    from collections import OrderedDict

    grouped: OrderedDict[str, dict] = OrderedDict()

    for cr in child_rows:
        mapped = _map_row(cr, child_mapping)
        fid = str(mapped.get("feature_id") or "")

        if fid not in grouped:
            grouped[fid] = {
                "feature_id": fid,
                "description": mapped.get("description"),
                "unit": mapped.get("unit"),
                "values": [],
                "valueDescriptions": {},
                "valueTillDates": {},
            }

        entry = grouped[fid]

        # Collect values from configured columns
        for col in values_cols:
            try:
                v = cr[col]
            except (IndexError, KeyError):
                continue
            if v is not None and v != "":
                sv = str(v)
                if sv not in entry["values"]:
                    entry["values"].append(sv)

                # Collect value description if configured
                if value_desc_col:
                    try:
                        desc = cr[value_desc_col]
                    except (IndexError, KeyError):
                        desc = None
                    if desc is not None and desc != "":
                        entry["valueDescriptions"][sv] = str(desc)

                # Collect till-date if configured
                if till_date_col:
                    try:
                        td = cr[till_date_col]
                    except (IndexError, KeyError):
                        td = None
                    if td is not None and td != "":
                        entry["valueTillDates"][sv] = str(td)

    return list(grouped.values())


# ---------------------------------------------------------------------------
# Main import logic
# ---------------------------------------------------------------------------

def run_import(cfg: dict, *, dry_run: bool = False, force: bool = False, wipe: bool = False):
    # ---- target database session ----------------------------------------
    connect_args = {}
    if settings.DATABASE_URL.startswith("sqlite"):
        connect_args = {"check_same_thread": False}
    engine = create_engine(settings.DATABASE_URL, connect_args=connect_args)
    Base.metadata.create_all(bind=engine)  # ensure tables exist
    Session = sessionmaker(bind=engine)
    session = Session()

    # ---- safety check: is there already BOM data? -----------------------
    existing_count = session.query(func.count(BomItem.id)).scalar()
    if existing_count and wipe and not dry_run:
        print(f"Wiping {existing_count} existing BomItems (and their features)...")
        session.query(BomFeature).delete()
        session.query(BomItem).delete()
        session.commit()
        print("Wipe complete.")
    elif existing_count and not force and not dry_run:
        sys.exit(
            f"ERROR: bom_items already contains {existing_count} rows. "
            "Pass --force to overwrite, or --dry-run to preview."
        )

    # ---- source database ------------------------------------------------
    src = _open_source_db(cfg["source_db_path"])

    parent_table = cfg["parent_table"]
    child_table = cfg["child_table"]
    parent_pk = cfg["parent_pk_column"]
    child_fk = cfg["child_fk_column"]
    parent_mapping = cfg["parent_to_bom_item"]
    child_mapping = cfg["child_to_bom_feature"]
    values_cols = cfg.get("child_values_columns", [])
    value_desc_col = cfg.get("child_value_description_column")
    till_date_col = cfg.get("child_value_till_date_column")

    # Read parent rows
    parent_rows = src.execute(
        f"SELECT * FROM [{parent_table}]"  # brackets for safety with special names
    ).fetchall()
    print(f"Source: {len(parent_rows)} rows in [{parent_table}]")

    # Read child rows, indexed by FK value
    child_rows_all = src.execute(
        f"SELECT * FROM [{child_table}]"
    ).fetchall()
    child_by_parent: dict[str, list] = {}
    for cr in child_rows_all:
        key = str(cr[child_fk])
        child_by_parent.setdefault(key, []).append(cr)
    print(f"Source: {len(child_rows_all)} rows in [{child_table}]")

    # ---- map & insert ---------------------------------------------------
    items_created = 0
    features_created = 0
    skipped = 0

    try:
        for pr in parent_rows:
            mapped_item = _map_row(pr, parent_mapping)

            # item_id is required
            if not mapped_item.get("item_id"):
                skipped += 1
                continue

            child_rows = child_by_parent.get(str(pr[parent_pk]), [])
            grouped_features = _group_children_by_feature(
                child_rows, child_mapping, values_cols, value_desc_col, till_date_col,
            )

            if dry_run:
                print(
                    f"  [DRY-RUN] BomItem(item_id={mapped_item['item_id']!r}, "
                    f"description={mapped_item.get('description')!r}) "
                    f"-> {len(grouped_features)} features"
                )
                for gf in grouped_features:
                    vals = gf["values"]
                    descs = gf["valueDescriptions"]
                    till_dates = gf["valueTillDates"]
                    payload = {"values": vals, "valueDescriptions": descs}
                    if till_dates:
                        payload["valueTillDates"] = till_dates
                    if not descs and not till_dates:
                        payload = vals
                    print(
                        f"    Feature(feature_id={gf['feature_id']!r}, "
                        f"values={payload!r})"
                    )
                features_created += len(grouped_features)
                items_created += 1
                continue

            # Create BomItem
            bom_item = BomItem(
                item_id=str(mapped_item["item_id"]),
                description=mapped_item.get("description"),
                category=mapped_item.get("category"),
                product_type=mapped_item.get("product_type"),
            )
            session.add(bom_item)
            session.flush()  # get bom_item.id for FK

            # Create BomFeatures (grouped by feature_id)
            for gf in grouped_features:
                vals = gf["values"]
                descs = gf["valueDescriptions"]
                till_dates = gf["valueTillDates"]
                composite = {"values": vals, "valueDescriptions": descs}
                if till_dates:
                    composite["valueTillDates"] = till_dates
                if not descs and not till_dates:
                    composite = vals

                feature = BomFeature(
                    item_id=bom_item.id,
                    feature_id=gf["feature_id"],
                    description=gf.get("description"),
                    unit=gf.get("unit"),
                    values=composite,
                )
                session.add(feature)
                features_created += 1

            items_created += 1

        if not dry_run:
            session.commit()
            print(f"\nCommitted successfully.")
        else:
            print(f"\n[DRY-RUN] No data was written.")

    except Exception:
        if not dry_run:
            session.rollback()
        raise
    finally:
        session.close()
        src.close()

    print(f"Items:    {items_created}")
    print(f"Features: {features_created}")
    if skipped:
        print(f"Skipped:  {skipped} (missing item_id)")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Import BOM data from an external SQLite database using field-name mapping."
    )
    parser.add_argument(
        "--config",
        default="import_config.json",
        help="Path to the JSON config file (default: import_config.json)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview mapped rows without writing to the target database.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Allow import even if bom_items already contains data.",
    )
    parser.add_argument(
        "--wipe",
        action="store_true",
        help="Delete all existing BOM data before importing.",
    )
    args = parser.parse_args()

    cfg = _load_config(args.config)
    print(f"Config loaded: {args.config}")
    print(f"Source DB:     {cfg['source_db_path']}")
    print(f"Target DB:     {settings.DATABASE_URL}")
    print(f"Dry run:       {args.dry_run}")
    print(f"Force:         {args.force}")
    print(f"Wipe:          {args.wipe}")
    print("=" * 60)

    run_import(cfg, dry_run=args.dry_run, force=args.force, wipe=args.wipe)


if __name__ == "__main__":
    main()
