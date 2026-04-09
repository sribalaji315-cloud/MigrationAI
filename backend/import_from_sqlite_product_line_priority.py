"""Sync parent-table values into existing BOM items and derive priority.

This variant keeps the original importer unchanged and supports a simple
config-driven update flow for existing target rows. It reads parent
rows from a source SQLite table, maps the configured source columns into
``BomItem`` fields, matches by ``item_id``, and applies one optional rule:
when the mapped field named by ``priority_from_mapped_field`` is present and
non-empty, the target ``BomItem`` gets ``priority_value``.

Usage:
    cd backend
    python import_from_sqlite_product_line_priority.py --config import_config_product_line_priority.json
    python import_from_sqlite_product_line_priority.py --config import_config_product_line_priority.json --dry-run
    python import_from_sqlite_product_line_priority.py --config import_config_product_line_priority.json --force
"""

import argparse
import sys
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Ensure the backend package is importable when running from <repo>/backend/
# ---------------------------------------------------------------------------
_BACKEND_ROOT = Path(__file__).resolve().parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.db.models import BomFeature, BomItem
from app.db.session import Base
from import_from_sqlite import (
    _group_children_by_feature,
    _load_config,
    _map_row,
    _open_source_db,
)


def _normalize_optional_text(value: Any) -> Optional[str]:
    """Normalize optional text values used by mapped BOM fields."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _derive_priority_from_config(mapped_item: dict, cfg: dict) -> dict:
    """Apply the optional priority derivation rule from config."""
    priority_source_field = str(cfg.get("priority_from_mapped_field") or "").strip()
    priority_value = cfg.get("priority_value")

    normalized_product_type = _normalize_optional_text(mapped_item.get("product_type"))
    if "product_type" in mapped_item:
        mapped_item["product_type"] = normalized_product_type

    if not priority_source_field:
        return mapped_item

    source_value = mapped_item.get(priority_source_field)
    if isinstance(source_value, str):
        source_value = source_value.strip() or None
        mapped_item[priority_source_field] = source_value

    if source_value:
        mapped_item["priority"] = priority_value
    else:
        mapped_item.pop("priority", None)
    return mapped_item


def _run_existing_bom_item_updates(session, src, cfg: dict, *, dry_run: bool = False):
    """Update existing BomItem rows from parent-table mappings only."""
    parent_table = cfg["parent_table"]
    target_table = str(cfg.get("target_table") or BomItem.__tablename__).strip() or BomItem.__tablename__
    parent_mapping = cfg["parent_to_bom_item"]

    if target_table != BomItem.__tablename__:
        raise ValueError(
            f"Unsupported target_table {target_table!r}. "
            f"This updater currently supports only {BomItem.__tablename__!r}."
        )

    parent_rows = src.execute(f"SELECT * FROM [{parent_table}]").fetchall()
    valid_columns = set(BomItem.__table__.columns.keys())

    print(f"Source: {len(parent_rows)} rows in [{parent_table}]")
    print(f"Target: {target_table}")

    updated = 0
    skipped = 0
    not_found = 0

    for pr in parent_rows:
        mapped_item = _map_row(pr, parent_mapping)
        mapped_item = _derive_priority_from_config(mapped_item, cfg)

        item_id = _normalize_optional_text(mapped_item.get("item_id"))
        if not item_id:
            skipped += 1
            continue

        bom_item = session.query(BomItem).filter(BomItem.item_id == item_id).first()
        if bom_item is None:
            not_found += 1
            continue

        changed_fields: list[str] = []
        for target_field, value in mapped_item.items():
            if target_field == "item_id" or target_field not in valid_columns:
                continue
            if getattr(bom_item, target_field) != value:
                changed_fields.append(f"{target_field}={value!r}")
                if not dry_run:
                    setattr(bom_item, target_field, value)

        if not changed_fields:
            continue

        updated += 1
        if dry_run:
            print(f"  [DRY-RUN] BomItem(item_id={item_id!r}) <- {', '.join(changed_fields)}")

    if not dry_run:
        session.commit()
        print("\nCommitted successfully.")
    else:
        print("\n[DRY-RUN] No data was written.")

    print(f"Updated:  {updated}")
    if skipped:
        print(f"Skipped:  {skipped} (missing item_id)")
    if not_found:
        print(f"Not found: {not_found} (no matching {target_table} row)")

    return


def run_import(cfg: dict, *, dry_run: bool = False, force: bool = False, wipe: bool = False):
    # ---- target database session ----------------------------------------
    connect_args = {}
    if settings.DATABASE_URL.startswith("sqlite"):
        connect_args = {"check_same_thread": False}
    engine = create_engine(settings.DATABASE_URL, connect_args=connect_args)
    Base.metadata.create_all(bind=engine)
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

    if cfg.get("update_existing_bom_items_only"):
        try:
            _run_existing_bom_item_updates(session, src, cfg, dry_run=dry_run)
        finally:
            session.close()
            src.close()
        return

    parent_table = cfg["parent_table"]
    child_table = cfg["child_table"]
    parent_pk = cfg["parent_pk_column"]
    child_fk = cfg["child_fk_column"]
    parent_mapping = cfg["parent_to_bom_item"]
    child_mapping = cfg["child_to_bom_feature"]
    values_cols = cfg.get("child_values_columns", [])
    value_desc_col = cfg.get("child_value_description_column")

    parent_rows = src.execute(f"SELECT * FROM [{parent_table}]").fetchall()
    print(f"Source: {len(parent_rows)} rows in [{parent_table}]")

    child_rows_all = src.execute(f"SELECT * FROM [{child_table}]").fetchall()
    child_by_parent: dict[str, list] = {}
    for cr in child_rows_all:
        key = str(cr[child_fk])
        child_by_parent.setdefault(key, []).append(cr)
    print(f"Source: {len(child_rows_all)} rows in [{child_table}]")

    items_created = 0
    features_created = 0
    skipped = 0

    try:
        for pr in parent_rows:
            mapped_item = _map_row(pr, parent_mapping)
            mapped_item = _derive_priority_from_config(mapped_item, cfg)

            if not mapped_item.get("item_id"):
                skipped += 1
                continue

            child_rows = child_by_parent.get(str(pr[parent_pk]), [])
            grouped_features = _group_children_by_feature(
                child_rows, child_mapping, values_cols, value_desc_col,
            )

            if dry_run:
                print(
                    f"  [DRY-RUN] BomItem(item_id={mapped_item['item_id']!r}, "
                    f"description={mapped_item.get('description')!r}, "
                    f"product_type={mapped_item.get('product_type')!r}, "
                    f"priority={mapped_item.get('priority')!r}) "
                    f"-> {len(grouped_features)} features"
                )
                for gf in grouped_features:
                    vals = gf["values"]
                    descs = gf["valueDescriptions"]
                    payload = {"values": vals, "valueDescriptions": descs} if descs else vals
                    print(
                        f"    Feature(feature_id={gf['feature_id']!r}, "
                        f"values={payload!r})"
                    )
                features_created += len(grouped_features)
                items_created += 1
                continue

            bom_item = BomItem(
                item_id=str(mapped_item["item_id"]),
                description=mapped_item.get("description"),
                category=mapped_item.get("category"),
                product_type=mapped_item.get("product_type"),
                priority=mapped_item.get("priority"),
            )
            session.add(bom_item)
            session.flush()

            for gf in grouped_features:
                vals = gf["values"]
                descs = gf["valueDescriptions"]
                composite = {"values": vals, "valueDescriptions": descs} if descs else vals

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
            print("\nCommitted successfully.")
        else:
            print("\n[DRY-RUN] No data was written.")

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


def main():
    parser = argparse.ArgumentParser(
        description=(
            "Import BOM data from SQLite using field-name mapping and derive priority "
            "from mapped product line values."
        )
    )
    parser.add_argument(
        "--config",
        default="import_config_product_line_priority.json",
        help="Path to the JSON config file (default: import_config_product_line_priority.json)",
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