"""
One-time cleanup: remove the 'discontinued' value status from workspace
mappings that have a feasibility value.

For every row in the `workspace_mappings` table where `feasibility` is set
(non-empty) and `value_status` equals 'discontinued', reset `value_status`
back to NULL (active).

Usage:
    cd backend
    python clear_discontinued_with_feasibility.py
    python clear_discontinued_with_feasibility.py --dry-run
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
                WorkspaceMapping.feasibility.isnot(None),
                WorkspaceMapping.feasibility != "",
                WorkspaceMapping.value_status == "discontinued",
            )
            .all()
        )

        print(
            f"Found {len(rows)} workspace mapping(s) with a feasibility value "
            f"and value_status='discontinued'."
        )

        for row in rows[:20]:
            print(
                f"  - id={row.id} item={row.legacy_item_id} "
                f"feature={row.legacy_feature_id} value='{row.legacy_value}' "
                f"feasibility='{row.feasibility}'"
            )
        if len(rows) > 20:
            print(f"  ... and {len(rows) - 20} more")

        if dry_run:
            print("Dry run — no changes written.")
            return

        for row in rows:
            row.value_status = None

        session.commit()
        print(f"Cleared discontinued status on {len(rows)} workspace mapping(s).")
    finally:
        session.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            "Remove the 'discontinued' value status from workspace mappings "
            "that have a feasibility value."
        )
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report affected rows without writing any changes.",
    )
    args = parser.parse_args()
    run(dry_run=args.dry_run)
