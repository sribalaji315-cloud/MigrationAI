"""
One-time cleanup: set the target value to 'NOT REQUIRED' for workspace
mappings whose feasibility is 'no'.

For every row in the `workspace_mappings` table where trimmed `feasibility`
equals 'no' case-insensitively and `new_value` is not already
'NOT REQUIRED', set `new_value` to 'NOT REQUIRED'.

Usage:
    cd backend
    python set_not_required_for_no_feasibility.py
    python set_not_required_for_no_feasibility.py --dry-run
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
from app.db.models import WorkspaceMapping
from app.db.session import Base

TARGET_VALUE = "NOT REQUIRED"
FEASIBILITY_VALUE = "no"


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
                func.lower(func.trim(WorkspaceMapping.feasibility)) == FEASIBILITY_VALUE,
                WorkspaceMapping.new_value != TARGET_VALUE,
            )
            .all()
        )

        print(
            f"Found {len(rows)} workspace mapping(s) with feasibility='no' "
            f"and new_value != '{TARGET_VALUE}'."
        )

        for row in rows[:20]:
            print(
                f"  - id={row.id} item={row.legacy_item_id} "
                f"feature={row.legacy_feature_id} value='{row.legacy_value}' "
                f"feasibility='{row.feasibility}' new_value='{row.new_value}'"
            )
        if len(rows) > 20:
            print(f"  ... and {len(rows) - 20} more")

        if dry_run:
            print("Dry run - no changes written.")
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
            "whose feasibility is 'no'."
        )
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report affected rows without writing any changes.",
    )
    args = parser.parse_args()
    run(dry_run=args.dry_run)