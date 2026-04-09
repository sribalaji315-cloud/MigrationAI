"""
Promote uncategorized workspace mappings to the global_mappings table.

Finds all workspace_mapping rows whose attribute_type is empty (uncategorized)
and whose legacy_feature_id does NOT already appear in any global_mapping.
For each such feature, creates a new global_mapping row with:
  - legacy_feature_ids: [feature_id]
  - new_attribute_id: ""  (UNMAPPED)
  - attribute_type: ""    (uncategorized)
  - value_mappings: { legacyValue: newValue, ... }

Usage:
    cd backend
    python promote_uncategorized_to_global.py
    python promote_uncategorized_to_global.py --dry-run
"""

import argparse
import sys
from collections import defaultdict
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.db.models import GlobalMapping, WorkspaceMapping
from app.db.session import Base


def run(dry_run: bool = False):
    connect_args = {}
    if settings.DATABASE_URL.startswith("sqlite"):
        connect_args = {"check_same_thread": False}
    engine = create_engine(settings.DATABASE_URL, connect_args=connect_args)
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()

    # 1. Collect all feature IDs already covered by a global mapping.
    #    Also index existing rows for merging new values.
    covered_features: set[str] = set()
    existing_gm_by_feature: dict[str, GlobalMapping] = {}
    for gm in session.query(GlobalMapping).all():
        for fid in (gm.legacy_feature_ids or []):
            norm_fid = str(fid).strip()
            covered_features.add(norm_fid)
            if norm_fid not in existing_gm_by_feature:
                existing_gm_by_feature[norm_fid] = gm

    print(f"Global mappings already cover {len(covered_features)} unique feature IDs.")

    # 2. Query uncategorized workspace mappings (empty attribute_type)
    uncat_rows = (
        session.query(WorkspaceMapping)
        .filter(
            (WorkspaceMapping.attribute_type == "")
            | (WorkspaceMapping.attribute_type == None)  # noqa: E711
        )
        .all()
    )
    print(f"Found {len(uncat_rows)} uncategorized workspace mapping rows.")

    # 3. Group by legacy_feature_id, collecting value mappings.
    #    Separate into "new" features and "covered" features (for merging).
    feature_values: dict[str, dict[str, str]] = defaultdict(dict)
    features_to_merge: dict[str, dict[str, str]] = defaultdict(dict)
    for row in uncat_rows:
        fid = str(row.legacy_feature_id or "").strip()
        if not fid:
            continue
        legacy_val = row.legacy_value or ""
        new_val = row.new_value or ""
        target = features_to_merge[fid] if fid in covered_features else feature_values[fid]
        # Keep the first non-empty new_value seen for each legacy value
        if legacy_val not in target or (not target[legacy_val] and new_val):
            target[legacy_val] = new_val

    # 3b. Merge new values into existing global mappings for covered features
    merged_count = 0
    for fid, vals in features_to_merge.items():
        gm = existing_gm_by_feature.get(fid)
        if not gm:
            continue
        existing_vals = dict(gm.value_mappings or {})
        added = 0
        for k, v in vals.items():
            if k not in existing_vals:
                existing_vals[k] = v
                added += 1
            elif not existing_vals[k] and v:
                existing_vals[k] = v
                added += 1
        if added:
            merged_count += 1
            if not dry_run:
                gm.value_mappings = existing_vals
    if merged_count:
        if dry_run:
            print(f"[DRY-RUN] Would merge new values into {merged_count} existing global mappings.")
        else:
            session.commit()
            print(f"Merged new values into {merged_count} existing global mappings.")

    print(f"Found {len(feature_values)} uncovered feature IDs from workspace mappings.")

    if not feature_values:
        print("Nothing to do – all uncategorized workspace features already have a global mapping.")
        session.close()
        return

    # 4. Create global mapping rows
    rows_to_add = []
    for fid in sorted(feature_values):
        vals = feature_values[fid]
        value_mappings = {k: vals[k] for k in sorted(vals)}
        rows_to_add.append(
            {
                "legacy_feature_ids": [fid],
                "new_attribute_id": "",
                "attribute_type": "",
                "value_mappings": value_mappings,
            }
        )

    if dry_run:
        print(f"[DRY-RUN] Would create {len(rows_to_add)} global mapping rows.")
        for row in rows_to_add[:30]:
            fid = row["legacy_feature_ids"][0]
            n_vals = len(row["value_mappings"])
            print(f"  feature={fid!r}  values={n_vals}")
        if len(rows_to_add) > 30:
            print(f"  ... and {len(rows_to_add) - 30} more")
    else:
        session.bulk_insert_mappings(GlobalMapping, rows_to_add)
        session.commit()
        print(f"Created {len(rows_to_add)} global mapping rows from uncategorized workspace mappings.")

    session.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Promote uncategorized workspace mappings to global mappings"
    )
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    args = parser.parse_args()
    run(dry_run=args.dry_run)
