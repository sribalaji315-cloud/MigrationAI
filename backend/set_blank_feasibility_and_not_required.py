"""
One-time cleanup for workspace mappings:

1. Wherever feasibility is blank (NULL or empty), set feasibility='No' and
   value_status='discontinued'.
2. Wherever feasibility='No', set new_value='NOT REQUIRED'.

Step 1 runs first so rows that just became 'No' are also picked up by step 2.

Usage:
    cd backend
    python set_blank_feasibility_and_not_required.py
    python set_blank_feasibility_and_not_required.py --dry-run
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
DISCONTINUED = "discontinued"


def _blank_filter():
    return or_(
        WorkspaceMapping.feasibility.is_(None),
        WorkspaceMapping.feasibility == "",
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
        # --- Step 1: blank feasibility -> 'No' + value_status='discontinued'
        blank_count = (
            session.query(WorkspaceMapping).filter(_blank_filter()).count()
        )
        print(
            f"Step 1: {blank_count} workspace mapping(s) with blank feasibility "
            f"-> set feasibility='No', value_status='{DISCONTINUED}'."
        )
        for row in (
            session.query(WorkspaceMapping)
            .filter(_blank_filter())
            .limit(20)
            .all()
        ):
            print(
                f"  - id={row.id} item={row.legacy_item_id} "
                f"feature={row.legacy_feature_id} value='{row.legacy_value}' "
                f"new_value='{row.new_value}'"
            )
        if blank_count > 20:
            print(f"  ... and {blank_count - 20} more")

        # --- Step 2: any 'No' (incl. just-flipped blanks) -> new_value='NOT REQUIRED'
        step2_filter = or_(
            WorkspaceMapping.feasibility == "No",
            _blank_filter(),
        )
        step2_count = (
            session.query(WorkspaceMapping)
            .filter(step2_filter, WorkspaceMapping.new_value != TARGET_VALUE)
            .count()
        )
        print(
            f"Step 2: {step2_count} workspace mapping(s) with feasibility='No' "
            f"(including newly flipped) and new_value != '{TARGET_VALUE}' "
            f"-> set new_value='{TARGET_VALUE}'."
        )

        if dry_run:
            print("Dry run — no changes written.")
            return

        # Step 1 write
        updated1 = (
            session.query(WorkspaceMapping)
            .filter(_blank_filter())
            .update(
                {
                    WorkspaceMapping.feasibility: "No",
                    WorkspaceMapping.value_status: DISCONTINUED,
                },
                synchronize_session=False,
            )
        )

        # Step 2 write (now all targeted rows have feasibility='No')
        updated2 = (
            session.query(WorkspaceMapping)
            .filter(
                WorkspaceMapping.feasibility == "No",
                WorkspaceMapping.new_value != TARGET_VALUE,
            )
            .update(
                {WorkspaceMapping.new_value: TARGET_VALUE},
                synchronize_session=False,
            )
        )

        session.commit()
        print(
            f"Done. Step 1 updated {updated1} row(s); "
            f"Step 2 set new_value='{TARGET_VALUE}' on {updated2} row(s)."
        )
    finally:
        session.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            "Set blank feasibility to 'No' (value_status='discontinued') and "
            "set new_value to 'NOT REQUIRED' for feasibility='No' rows."
        )
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report affected rows without writing any changes.",
    )
    args = parser.parse_args()
    run(dry_run=args.dry_run)
