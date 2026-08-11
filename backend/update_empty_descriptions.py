"""
Fill in bom_items.description from a CSV wherever the DB description is empty.

Usage (from <repo>/backend):
    python update_empty_descriptions.py --csv "C:/Users/ISA2/OneDrive - HAWORTH INC/Downloads/descriptions.csv"
    python update_empty_descriptions.py --csv "..." --dry-run

CSV shape::

    item_id,Custom
    A0000493,"BuzziFix Bold L part C,assembl..."

Notes:
- The CSV may contain duplicate ``item_id`` rows with different descriptions.
  The FIRST non-empty description seen per ``item_id`` wins.
- Only ``bom_items`` rows whose description is NULL, empty, or whitespace-only
  are updated. Items already having a description are left untouched.
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Ensure the backend package is importable when running from <repo>/backend/
# ---------------------------------------------------------------------------
_BACKEND_ROOT = Path(__file__).resolve().parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.db.models import BomItem            # noqa: E402
from app.db.session import SessionLocal      # noqa: E402


def _is_empty(value: str | None) -> bool:
    return value is None or not value.strip()


def load_descriptions(csv_path: Path) -> dict[str, str]:
    """Return {item_id: description}, keeping the FIRST non-empty value per id."""
    mapping: dict[str, str] = {}
    with csv_path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            item_id = (row.get("item_id") or "").strip()
            desc = (row.get("Custom") or "").strip()
            if not item_id or not desc:
                continue
            if item_id not in mapping:  # first occurrence wins
                mapping[item_id] = desc
    return mapping


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fill empty bom_items.description values from a CSV."
    )
    parser.add_argument("--csv", required=True, help="Path to descriptions.csv")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report changes without committing to the database.",
    )
    args = parser.parse_args()

    csv_path = Path(args.csv)
    if not csv_path.exists():
        print(f"CSV not found: {csv_path}")
        return 1

    descriptions = load_descriptions(csv_path)
    print(f"Loaded {len(descriptions)} item_id -> description entries from CSV")

    updated = 0
    missing = 0

    db = SessionLocal()
    try:
        # Only pull items whose description is empty in the DB.
        items = (
            db.query(BomItem)
            .filter((BomItem.description.is_(None)) | (BomItem.description == ""))
            .all()
        )
        print(f"Found {len(items)} bom_items with empty description")

        for item in items:
            if not _is_empty(item.description):
                continue
            new_desc = descriptions.get(item.item_id)
            if new_desc is None:
                missing += 1
                continue
            item.description = new_desc
            updated += 1

        if args.dry_run:
            print(
                f"[DRY RUN] would update {updated} items "
                f"({missing} empty items had no CSV match)"
            )
            db.rollback()
        else:
            db.commit()
            print(
                f"Updated {updated} items "
                f"({missing} empty items had no CSV match)"
            )
    finally:
        db.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
