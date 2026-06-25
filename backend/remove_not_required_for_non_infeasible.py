"""
One-time cleanup: remove an erroneous 'NOT REQUIRED' target value from
workspace mappings that are NOT infeasible.

For every row in the `workspace_mappings` table where `new_value` equals
'NOT REQUIRED', `feasibility` is anything other than 'No', and `value_status`
is empty (NULL or ''), reset `new_value` back to '' (unmapped).

Usage:
    cd backend
    python remove_not_required_for_non_infeasible.py
    python remove_not_required_for_non_infeasible.py --dry-run
"""

import argparse
import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from sqlalchemy import create_engine, or_
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.db.models import WorkspaceMapping
from app.db.session import Base

TARGET_VALUE = "NOT REQUIRED"


def run(dry_run: bool = False):
    connect_args = {}
    if settings.DATABASE_URL.startswith("sqlite"):
        connect_args = {"check_same_thread": False}
    engine = create_engine(settings.DATABASE_URL, connect_args=connect_args)
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()

    try:
        rows = (
            session.query(WorkspaceMapping)
            .filter(
                WorkspaceMapping.new_value == TARGET_VALUE,
                or_(
                    WorkspaceMapping.feasibility.is_(None),
                    WorkspaceMapping.feasibility != "No",
                ),
                or_(
                    WorkspaceMapping.value_status.is_(None),
                    WorkspaceMapping.value_status == "",
                ),
            )
            .all()
        )

        print(
            f"Found {len(rows)} workspace mapping(s) with new_value='{TARGET_VALUE}', "
            f"feasibility != 'No', and empty value_status."
        )

        for row in rows[:20]:
            print(
                f"  - id={row.id} item={row.legacy_item_id} "
                f"feature={row.legacy_feature_id} value='{row.legacy_value}' "
                f"feasibility='{row.feasibility}' value_status='{row.value_status}'"
            )
        if len(rows) > 20:
            print(f"  ... and {len(rows) - 20} more")

        if dry_run:
            print("Dry run — no changes written.")
            return

        for row in rows:
            row.new_value = ""

        session.commit()
        print(f"Cleared '{TARGET_VALUE}' target value on {len(rows)} workspace mapping(s).")
    finally:
        session.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            "Remove an erroneous 'NOT REQUIRED' target value from workspace "
            "mappings whose feasibility is not 'No' and value_status is empty."
        )
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report affected rows without writing any changes.",
    )
    args = parser.parse_args()
    run(dry_run=args.dry_run)
