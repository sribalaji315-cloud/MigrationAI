"""
One-time cleanup: set the target value to 'NOT REQUIRED' for workspace
mappings whose feasibility is 'No'.

For every row in the `workspace_mappings` table where `feasibility` equals
'No' and `new_value` is not already 'NOT REQUIRED', set `new_value` to
'NOT REQUIRED'.

Usage:
    cd backend
    python set_not_required_for_infeasible.py
    python set_not_required_for_infeasible.py --dry-run
"""

import argparse
import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from sqlalchemy import create_engine
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
                WorkspaceMapping.feasibility == "No",
                WorkspaceMapping.new_value != TARGET_VALUE,
            )
            .all()
        )

        print(
            f"Found {len(rows)} workspace mapping(s) with feasibility='No' "
            f"and new_value != '{TARGET_VALUE}'."
        )

        for row in rows[:20]:
            print(
                f"  - id={row.id} item={row.legacy_item_id} "
                f"feature={row.legacy_feature_id} value='{row.legacy_value}' "
                f"new_value='{row.new_value}'"
            )
        if len(rows) > 20:
            print(f"  ... and {len(rows) - 20} more")

        if dry_run:
            print("Dry run — no changes written.")
            return

        for row in rows:
            row.new_value = TARGET_VALUE

        session.commit()
        print(f"Set new_value='{TARGET_VALUE}' on {len(rows)} workspace mapping(s).")
    finally:
        session.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            "Set the target value to 'NOT REQUIRED' for workspace mappings "
            "whose feasibility is 'No'."
        )
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report affected rows without writing any changes.",
    )
    args = parser.parse_args()
    run(dry_run=args.dry_run)
