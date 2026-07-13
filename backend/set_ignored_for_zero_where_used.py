"""
One-time cleanup: set value_status to 'ignored' for group features whose
group has a where-used count of zero.

The where-used count for a group is the number of BOM items that use ALL
distinct feature_ids belonging to that group (this mirrors the calculation
used by the /group-features list and stats endpoints). For every group whose
where-used count is 0, every group_features row in that group has its
value_status set to 'ignored'. Rows already marked 'discontinued' are left
unchanged.

Usage:
    cd backend
    python set_ignored_for_zero_where_used.py
    python set_ignored_for_zero_where_used.py --dry-run
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
from app.db.models import GroupFeature, BomFeature
from app.db.session import Base

TARGET_STATUS = "ignored"
PRESERVE_STATUS = "discontinued"


def _where_used_count(session, group: str) -> int:
    """Number of BOM items that use ALL distinct feature_ids in the group."""
    sub_fids = [
        row[0]
        for row in session.query(GroupFeature.feature_id)
        .filter(GroupFeature.feature_group == group)
        .distinct()
        .all()
    ]
    if not sub_fids:
        return 0
    return (
        session.query(BomFeature.item_id)
        .filter(BomFeature.feature_id.in_(sub_fids))
        .group_by(BomFeature.item_id)
        .having(func.count(BomFeature.feature_id.distinct()) == len(sub_fids))
        .count()
    )


def run(dry_run: bool = False):
    connect_args = {}
    if settings.DATABASE_URL.startswith("sqlite"):
        connect_args = {"check_same_thread": False}
    engine = create_engine(settings.DATABASE_URL, connect_args=connect_args)
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()

    try:
        groups = [
            r[0]
            for r in session.query(GroupFeature.feature_group).distinct().all()
            if r[0]
        ]

        zero_groups = [g for g in groups if _where_used_count(session, g) == 0]

        rows = (
            session.query(GroupFeature)
            .filter(
                GroupFeature.feature_group.in_(zero_groups),
                GroupFeature.value_status != TARGET_STATUS,
                GroupFeature.value_status != PRESERVE_STATUS,
            )
            .all()
            if zero_groups
            else []
        )

        print(
            f"Found {len(zero_groups)} group(s) with where-used=0 covering "
            f"{len(rows)} row(s) not already '{TARGET_STATUS}' "
            f"(excluding '{PRESERVE_STATUS}')."
        )

        for row in rows[:20]:
            print(
                f"  - id={row.id} group={row.feature_group} "
                f"feature={row.feature_id} option='{row.option}' "
                f"status='{row.value_status}'"
            )
        if len(rows) > 20:
            print(f"  ... and {len(rows) - 20} more")

        if dry_run:
            print("Dry run - no changes written.")
            return

        for row in rows:
            row.value_status = TARGET_STATUS

        session.commit()
        print(f"Set value_status='{TARGET_STATUS}' on {len(rows)} group feature row(s).")
    finally:
        session.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            "Set value_status to 'ignored' for group features whose group "
            "has a where-used count of zero. Rows already marked "
            "'discontinued' are left unchanged."
        )
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report affected rows without writing any changes.",
    )
    args = parser.parse_args()
    run(dry_run=args.dry_run)
