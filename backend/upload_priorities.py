"""Upload BOM item priorities from a CSV or Excel file.

Usage:
    python upload_priorities.py <csv_or_xlsx_file>

File format (header required, first sheet for Excel):
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


# Accepted header names (lowercased) mapped to the canonical field.
_ITEM_ID_ALIASES = ("item_id", "item", "itemid", "item id", "item number", "item_number")
_PRIORITY_ALIASES = ("priority", "prio")


def _find_index(headers, aliases):
    """Return the index of the first header matching one of the aliases, or None."""
    for i, h in enumerate(headers):
        if h in aliases:
            return i
    return None


def _read_rows(path: Path):
    """Yield (item_id, priority) string pairs from a CSV or XLSX file.

    Header names are matched case-insensitively and accept common aliases
    (e.g. 'Item' for item_id). Raises ValueError if the required columns
    are missing.
    """
    if path.suffix.lower() in (".xlsx", ".xlsm"):
        try:
            from openpyxl import load_workbook
        except ImportError:
            raise ValueError(
                "Reading Excel files requires openpyxl. Install it with: pip install openpyxl"
            )

        wb = load_workbook(path, read_only=True, data_only=True)
        try:
            ws = wb.active
            rows = ws.iter_rows(values_only=True)
            try:
                header = next(rows)
            except StopIteration:
                raise ValueError("Excel sheet is empty.")

            headers = [str(h).strip().lower() if h is not None else "" for h in header]
            id_idx = _find_index(headers, _ITEM_ID_ALIASES)
            prio_idx = _find_index(headers, _PRIORITY_ALIASES)
            if id_idx is None or prio_idx is None:
                raise ValueError(
                    f"Excel must have item id and priority columns. Found: {headers}"
                )

            for row in rows:
                item_id = row[id_idx] if id_idx < len(row) else None
                priority = row[prio_idx] if prio_idx < len(row) else None
                item_id = "" if item_id is None else str(item_id).strip()
                priority = "" if priority is None else str(priority).strip()
                yield item_id, priority
        finally:
            wb.close()
    else:
        with open(path, newline="", encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            try:
                header = next(reader)
            except StopIteration:
                raise ValueError("CSV file is empty.")

            headers = [(h or "").strip().lower() for h in header]
            id_idx = _find_index(headers, _ITEM_ID_ALIASES)
            prio_idx = _find_index(headers, _PRIORITY_ALIASES)
            if id_idx is None or prio_idx is None:
                raise ValueError(
                    f"CSV must have item id and priority columns. Found: {headers}"
                )

            for row in reader:
                item_id = row[id_idx] if id_idx < len(row) else ""
                priority = row[prio_idx] if prio_idx < len(row) else ""
                yield (item_id or "").strip(), (priority or "").strip()


def main():
    if len(sys.argv) < 2:
        print("Usage: python upload_priorities.py <csv_or_xlsx_file>")
        sys.exit(1)

    src_path = Path(sys.argv[1])
    if not src_path.is_file():
        print(f"File not found: {src_path}")
        sys.exit(1)

    db = SessionLocal()
    try:
        updated = 0
        not_found = []

        try:
            rows = _read_rows(src_path)
        except ValueError as e:
            print(e)
            sys.exit(1)

        for item_id, raw_priority in rows:
            if not item_id:
                continue

            priority = int(float(raw_priority)) if raw_priority else None

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
