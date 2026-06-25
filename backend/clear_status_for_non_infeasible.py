"""
One-time cleanup: correct workspace mappings that are NOT infeasible.

For every row in the `workspace_mappings` table where `feasibility` is anything
other than 'No' (i.e. NULL, '', 'Yes', etc.):

1. Clear `value_status` (set to NULL / empty).
2. If `new_value` (target value) equals 'NOT REQUIRED', reset it to ''
   (unmapped).

Usage:
    cd backend
    python clear_status_for_non_infeasible.py
    python clear_status_for_non_infeasible.py --dry-run
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


def _non_infeasible_filter():
    return or_(
        WorkspaceMapping.feasibility.is_(None),
        WorkspaceMapping.feasibility != "No",
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
        # --- Rows with a non-empty value_status to clear
        status_rows = (
            session.query(WorkspaceMapping)
            .filter(
                _non_infeasible_filter(),
                WorkspaceMapping.value_status.isnot(None),
                WorkspaceMapping.value_status != "",
            )
            .all()
        )
        print(
            f"Found {len(status_rows)} non-infeasible workspace mapping(s) "
            f"with a value_status to clear."
        )
        for row in status_rows[:20]:
            print(
                f"  - id={row.id} item={row.legacy_item_id} "
                f"feature={row.legacy_feature_id} value='{row.legacy_value}' "
                f"feasibility='{row.feasibility}' value_status='{row.value_status}'"
            )
        if len(status_rows) > 20:
            print(f"  ... and {len(status_rows) - 20} more")

        # --- Rows with a 'NOT REQUIRED' target value to clear
        value_rows = (
            session.query(WorkspaceMapping)
            .filter(
                _non_infeasible_filter(),
                WorkspaceMapping.new_value == TARGET_VALUE,
            )
            .all()
        )
        print(
            f"Found {len(value_rows)} non-infeasible workspace mapping(s) "
            f"with new_value='{TARGET_VALUE}' to clear."
        )
        for row in value_rows[:20]:
            print(
                f"  - id={row.id} item={row.legacy_item_id} "
                f"feature={row.legacy_feature_id} value='{row.legacy_value}' "
                f"feasibility='{row.feasibility}'"
            )
        if len(value_rows) > 20:
            print(f"  ... and {len(value_rows) - 20} more")

        if dry_run:
            print("Dry run — no changes written.")
            return

        cleared_status = (
            session.query(WorkspaceMapping)
            .filter(
                _non_infeasible_filter(),
                WorkspaceMapping.value_status.isnot(None),
                WorkspaceMapping.value_status != "",
            )
            .update(
                {WorkspaceMapping.value_status: None},
                synchronize_session=False,
            )
        )

        cleared_value = (
            session.query(WorkspaceMapping)
            .filter(
                _non_infeasible_filter(),
                WorkspaceMapping.new_value == TARGET_VALUE,
            )
            .update(
                {WorkspaceMapping.new_value: ""},
                synchronize_session=False,
            )
        )

        session.commit()
        print(
            f"Done. Cleared value_status on {cleared_status} row(s); "
            f"cleared '{TARGET_VALUE}' target value on {cleared_value} row(s)."
        )
    finally:
        session.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            "Clear value_status and remove a 'NOT REQUIRED' target value from "
            "workspace mappings whose feasibility is not 'No'."
        )
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report affected rows without writing any changes.",
    )
    args = parser.parse_args()
    run(dry_run=args.dry_run)
