"""Upload BOM item priorities from a CSV file.

Usage:
    python upload_priorities.py <csv_file>

CSV format (header required):
    item_id,priority
    A33293101,1
    B44281002,2
    ...
"""

import csv
import sys
from pathlib import Path

# -- bootstrap SQLAlchemy without running the full FastAPI app --
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.db.session import SessionLocal
from app.db.models import BomItem


def main():
    if len(sys.argv) < 2:
        print("Usage: python upload_priorities.py <csv_file>")
        sys.exit(1)

    csv_path = Path(sys.argv[1])
    if not csv_path.is_file():
        print(f"File not found: {csv_path}")
        sys.exit(1)

    db = SessionLocal()
    try:
        updated = 0
        not_found = []

        with open(csv_path, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)

            # Validate header
            if "item_id" not in reader.fieldnames or "priority" not in reader.fieldnames:
                print("CSV must have 'item_id' and 'priority' columns.")
                print(f"Found columns: {reader.fieldnames}")
                sys.exit(1)

            for row in reader:
                item_id = row["item_id"].strip()
                raw_priority = row["priority"].strip()

                if not item_id:
                    continue

                priority = int(raw_priority) if raw_priority else None

                bom_item = db.query(BomItem).filter(BomItem.item_id == item_id).first()
                if bom_item is None:
                    not_found.append(item_id)
                    continue

                bom_item.priority = priority
                updated += 1

        db.commit()
        print(f"Updated {updated} item(s).")
        if not_found:
            print(f"Not found in DB ({len(not_found)}): {', '.join(not_found[:20])}")
            if len(not_found) > 20:
                print(f"  ... and {len(not_found) - 20} more")
    except Exception as e:
        db.rollback()
        print(f"Error: {e}")
        sys.exit(1)
    finally:
        db.close()


if __name__ == "__main__":
    main()
