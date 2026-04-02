"""
Create global_mapping placeholder rows for every BOM feature that does not
already have a global mapping.

Each new row gets:
  - legacy_feature_ids: [feature_id]
  - new_attribute_id: ""  (UNMAPPED)
  - attribute_type: ""    (uncategorized)
  - value_mappings: { "legacyValue": "" , ... }  (all values unmapped)

Usage:
    cd backend
    python create_missing_global_mappings.py
    python create_missing_global_mappings.py --dry-run
"""

import argparse
import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.db.models import BomFeature, GlobalMapping
from app.db.session import Base


def run(dry_run: bool = False):
    connect_args = {}
    if settings.DATABASE_URL.startswith("sqlite"):
        connect_args = {"check_same_thread": False}
    engine = create_engine(settings.DATABASE_URL, connect_args=connect_args)
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()

    # 1. Collect all feature IDs already covered by a global mapping
    covered_features: set[str] = set()
    for gm in session.query(GlobalMapping).all():
        for fid in (gm.legacy_feature_ids or []):
            covered_features.add(str(fid).strip())

    print(f"Global mappings already cover {len(covered_features)} unique feature IDs.")

    # 2. Collect all distinct feature IDs from BOM, along with their values
    #    Multiple BOM items can share the same feature_id; we merge values.
    feature_values: dict[str, set[str]] = {}
    for feat in session.query(BomFeature).yield_per(2000):
        fid = str(feat.feature_id or "").strip()
        if not fid:
            continue
        if fid in covered_features:
            continue

        if fid not in feature_values:
            feature_values[fid] = set()

        raw = feat.values
        if isinstance(raw, dict):
            vals = raw.get("values") or []
        elif isinstance(raw, list):
            vals = raw
        else:
            vals = []

        for v in vals:
            sv = str(v).strip()
            if sv:
                feature_values[fid].add(sv)

    print(f"Found {len(feature_values)} uncovered feature IDs in BOM.")

    if not feature_values:
        print("Nothing to do – all BOM features already have a global mapping.")
        session.close()
        return

    # 3. Create global mapping rows
    rows_to_add = []
    for fid in sorted(feature_values):
        vals = feature_values[fid]
        value_mappings = {v: "" for v in sorted(vals)}
        rows_to_add.append({
            "legacy_feature_ids": [fid],
            "new_attribute_id": "",
            "attribute_type": "",
            "value_mappings": value_mappings,
        })

    if dry_run:
        print(f"[DRY-RUN] Would create {len(rows_to_add)} global mapping rows.")
        for row in rows_to_add[:20]:
            fid = row["legacy_feature_ids"][0]
            n_vals = len(row["value_mappings"])
            print(f"  feature={fid!r}  values={n_vals}")
        if len(rows_to_add) > 20:
            print(f"  ... and {len(rows_to_add) - 20} more")
    else:
        session.bulk_insert_mappings(GlobalMapping, rows_to_add)
        session.commit()
        print(f"Created {len(rows_to_add)} global mapping rows.")

    session.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Create missing global mappings for BOM features")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    args = parser.parse_args()
    run(dry_run=args.dry_run)
