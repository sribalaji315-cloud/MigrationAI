"""Recover cleared group_feature targets from workspace_mappings.

The group-feature "Apply Mappings" job used to wipe target_attribute/target_value
for ALL rows (including approved ones) before repopulating only features that had
an active global mapping. That left many approved rows with blank targets. This
script restores those blanks from the authoritative workspace_mappings table.

Usage:
    python recover_group_feature_targets_from_workspace.py --dry-run
    python recover_group_feature_targets_from_workspace.py

Matching:
    group_features.feature_id  == workspace_mappings.legacy_feature_id
    group_features.option      == workspace_mappings.legacy_value (trimmed)

For each matched key the distinct non-blank new_attribute_id / new_value values
across all workspace_mappings rows are collected. A blank target is only filled
when exactly ONE distinct candidate exists; ambiguous keys (multiple distinct
candidate values) are reported and skipped.

Scope:
    Only rows with value_status == 'approved' are touched, and only blank
    target_attribute / target_value fields are filled. Existing non-blank values
    are never overwritten.
"""

import argparse
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, Optional, Set, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.db.models import GroupFeature, WorkspaceMapping
from app.db.session import SessionLocal

Key = Tuple[str, str]


def _trim(value: Optional[str]) -> str:
    return str(value or "").strip()


def _build_recovery_maps(db) -> Tuple[Dict[Key, Set[str]], Dict[Key, Set[str]]]:
    attr_map: Dict[Key, Set[str]] = defaultdict(set)
    val_map: Dict[Key, Set[str]] = defaultdict(set)

    rows = (
        db.query(
            WorkspaceMapping.legacy_feature_id,
            WorkspaceMapping.legacy_value,
            WorkspaceMapping.new_attribute_id,
            WorkspaceMapping.new_value,
        )
        .yield_per(5000)
    )
    for fid, opt, attr, val in rows:
        fid = _trim(fid)
        if not fid:
            continue
        key = (fid, _trim(opt))
        if _trim(attr):
            attr_map[key].add(_trim(attr))
        if _trim(val):
            val_map[key].add(_trim(val))
    return attr_map, val_map


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Report changes without writing.")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        attr_map, val_map = _build_recovery_maps(db)

        approved = (
            db.query(GroupFeature)
            .filter(GroupFeature.value_status == "approved")
            .all()
        )

        filled_attr = 0
        filled_val = 0
        ambiguous_attr = 0
        ambiguous_val = 0
        no_match_attr = 0
        no_match_val = 0

        for gf in approved:
            key = (_trim(gf.feature_id), _trim(gf.option))

            if not _trim(gf.target_attribute):
                cand = attr_map.get(key)
                if not cand:
                    no_match_attr += 1
                elif len(cand) == 1:
                    if not args.dry_run:
                        gf.target_attribute = next(iter(cand))
                    filled_attr += 1
                else:
                    ambiguous_attr += 1

            if not _trim(gf.target_value):
                cand = val_map.get(key)
                if not cand:
                    no_match_val += 1
                elif len(cand) == 1:
                    if not args.dry_run:
                        gf.target_value = next(iter(cand))
                    filled_val += 1
                else:
                    ambiguous_val += 1

        if not args.dry_run:
            db.commit()

        mode = "DRY RUN — no changes written" if args.dry_run else "Committed changes"
        print(mode)
        print(f"approved rows scanned: {len(approved)}")
        print(f"target_attribute filled: {filled_attr} (ambiguous skipped: {ambiguous_attr}, no match: {no_match_attr})")
        print(f"target_value filled:     {filled_val} (ambiguous skipped: {ambiguous_val}, no match: {no_match_val})")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
