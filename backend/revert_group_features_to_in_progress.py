"""
One-time cleanup: revert specific group feature options back to 'in_progress'
when they have no till_date.

Group feature rows are marked 'discontinued' during upload only when a
till_date is present. For the option codes listed below that have no till_date,
this restores value_status='in_progress'.

Usage:
    cd backend
    python revert_group_features_to_in_progress.py
    python revert_group_features_to_in_progress.py --dry-run
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
from app.db.models import GroupFeature
from app.db.session import Base

TARGET_STATUS = "in_progress"

# Option codes to revert to 'in_progress' when they have no till_date.
OPTIONS = [
    "FS101", "FS179", "FS294", "FS300", "FS315", "FS328", "FS365", "FS384",
    "FS443", "FS468", "FS508", "FS540", "FS542", "FS612", "FS908",
    "CUZ02", "CUZ08", "CUZ09", "CUZ12", "CUZ13", "CUZ18", "CUZ1E", "CUZ1F",
    "CUZ1J", "CUZ1K", "CUZ1L", "CUZ1N", "CUZ1P", "CUZ1R", "CUZ1V", "CUZ1W",
    "CUZ1Y", "CUZ21", "CUZ26", "CUZ28", "CUZ2Q", "CUZ2T", "CUZ2U", "CUZ2W",
    "CUZ2Z", "CUZ30", "CUZ31", "CUZ33", "CUZ35", "CUZ39", "CUZ3A", "CUZ3B",
    "CUZ47", "CUZ53", "CUZ58", "CUZ62", "CUZ63", "CUZ67", "CUZ82", "CUZ86",
    "CUZ90",
    "MF001", "MF002", "MF003", "MF005", "MF006", "MF007", "MF008", "MF009",
    "MF010", "MF011", "MF012", "MF013", "MF014", "MF015", "MF016", "MF017",
    "7K113", "7K123", "7K133", "7K143", "7K152", "7K163", "7K173", "7K183",
    "7K223", "7K233", "7K242", "7K252", "7K362", "7K373", "7K383", "7K393",
    "7K412", "7K422", "7K433", "7K443", "7K452", "7K543", "7K612", "7K632",
    "7K643", "7K653", "7K662", "7K672", "7K682", "7K692", "7K722", "7K733",
    "7K743", "7K753", "7K762", "7K773", "7K783", "7K823", "7K842", "7K852",
    "7K873", "7K912", "7K923", "7K933", "7K942", "7K954", "7K962", "7K973",
    "7K982",
    "LW00A", "LW00B", "LW00C", "LW00D", "LW00E", "LW00F", "LW00G", "LW00H",
    "LW00J", "LW00K", "LW00L", "LW00M", "LW00N", "LW00P", "LW00Q", "LW00R",
    "LW00S", "LW00T", "LW00V",
]


def run(dry_run: bool = False):
    options = sorted(set(OPTIONS))

    connect_args = {}
    if settings.DATABASE_URL.startswith("sqlite"):
        connect_args = {"check_same_thread": False}
    engine = create_engine(settings.DATABASE_URL, connect_args=connect_args)
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()

    try:
        rows = (
            session.query(GroupFeature)
            .filter(
                GroupFeature.option.in_(options),
                or_(
                    GroupFeature.till_date.is_(None),
                    GroupFeature.till_date == "",
                ),
                GroupFeature.value_status != TARGET_STATUS,
            )
            .all()
        )

        print(
            f"Found {len(rows)} group feature row(s) with no till_date and "
            f"value_status != '{TARGET_STATUS}' among {len(options)} option(s)."
        )

        for row in rows[:20]:
            print(
                f"  - id={row.id} group={row.feature_group} "
                f"feature={row.feature_id} option='{row.option}' "
                f"status='{row.value_status}'"
            )
        if len(rows) > 20:
            print(f"  ... and {len(rows) - 20} more")

        matched_options = {row.option for row in rows}
        missing = [opt for opt in options if opt not in matched_options]
        if missing:
            print(
                f"Note: {len(missing)} option(s) had no matching row to revert "
                f"(already in_progress, has a till_date, or not present): "
                f"{', '.join(missing)}"
            )

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
        description="Revert group feature options to 'in_progress' when no till_date."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would change without writing to the DB.",
    )
    args = parser.parse_args()
    run(dry_run=args.dry_run)
