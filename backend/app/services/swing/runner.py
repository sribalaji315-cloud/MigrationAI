"""Scalable entrypoint that computes swing feasibility/condition from the two
raw PowerBI xlsx files and writes ONLY ``feasibility`` + ``condition`` back into
``workspace_mappings`` (update-existing rows only).

Designed for up to ~3M expanded rows:

* xlsx parsed in read-only mode; expansion streamed per item (bounded memory).
* expanded rows streamed into a TEMP staging table in batches (never a giant
  in-memory dict).
* a single index-backed set-based ``UPDATE ... FROM`` applies the result,
  riding the existing ``uq_workspace_mappings_item_feature_value`` index.

Only ``feasibility``, ``condition``, ``updated_at``, ``modified_at``,
``modified_by`` and ``version`` are touched — nothing else in mapping generation.
``condition`` is only overwritten when the engine emits a non-null condition
(mirrors ``preserve_condition_when_empty`` in
``import_swing_feasibility_conditions.py``).
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Callable, Dict, Optional

from ...db.session import engine
from .expansion_engine import distinct_item_count, expand_all
from .xlsx_parser import parse_feature_groups, parse_item_configs

_STAGE_BATCH = 5000
_PROGRESS_EVERY = 250

ProgressCb = Optional[Callable[..., None]]


def _is_sqlite() -> bool:
    return engine.dialect.name == "sqlite"


def run_swing_expansion(
    item_xlsx_path: str,
    group_xlsx_path: str,
    *,
    dry_run: bool = False,
    progress_cb: ProgressCb = None,
) -> Dict[str, object]:
    if not _is_sqlite():
        raise NotImplementedError(
            "Swing expansion writer currently supports SQLite only "
            f"(database dialect is '{engine.dialect.name}')."
        )

    def report(**kwargs) -> None:
        if progress_cb is not None:
            progress_cb(**kwargs)

    report(phase="parsing", processed_items=0)
    item_configs = parse_item_configs(item_xlsx_path)
    feature_groups = parse_feature_groups(group_xlsx_path)

    total_items = distinct_item_count(item_configs)
    report(phase="expanding", total_items=total_items, processed_items=0)

    counts: Dict[str, int] = {"Yes": 0, "No": 0, "Conditional": 0, "Review": 0}
    total_rows = 0
    processed_items = 0
    matched = 0
    updated = 0

    raw = engine.raw_connection()
    try:
        cur = raw.cursor()
        cur.execute("DROP TABLE IF EXISTS swing_stage")
        cur.execute(
            "CREATE TEMP TABLE swing_stage "
            "(item TEXT, feature TEXT, value TEXT, feasibility TEXT, condition TEXT)"
        )

        batch = []
        for exp_item in expand_all(item_configs, feature_groups, datetime.utcnow()):
            for v in exp_item.values:
                counts[v.feasibility] = counts.get(v.feasibility, 0) + 1
                total_rows += 1
                batch.append(
                    (exp_item.item, v.feature, v.option, v.feasibility, v.condition)
                )
                if len(batch) >= _STAGE_BATCH:
                    cur.executemany(
                        "INSERT INTO swing_stage VALUES (?, ?, ?, ?, ?)", batch
                    )
                    batch.clear()
            processed_items += 1
            if processed_items % _PROGRESS_EVERY == 0:
                report(
                    phase="staging",
                    processed_items=processed_items,
                    total_items=total_items,
                    staged_rows=total_rows,
                )
        if batch:
            cur.executemany("INSERT INTO swing_stage VALUES (?, ?, ?, ?, ?)", batch)
            batch.clear()

        cur.execute(
            "CREATE INDEX ix_swing_stage ON swing_stage(item, feature, value)"
        )
        raw.commit()

        cur.execute(
            "SELECT COUNT(*) FROM workspace_mappings w JOIN swing_stage s "
            "ON w.legacy_item_id = s.item "
            "AND w.legacy_feature_id = s.feature "
            "AND w.legacy_value = s.value"
        )
        matched = int(cur.fetchone()[0])

        if not dry_run:
            report(
                phase="applying",
                processed_items=processed_items,
                total_items=total_items,
            )
            now = time.time()
            cur.execute(
                """
                UPDATE workspace_mappings
                SET feasibility = s.feasibility,
                    condition = CASE
                        WHEN s.condition IS NOT NULL THEN s.condition
                        ELSE workspace_mappings.condition
                    END,
                    updated_at = ?,
                    modified_at = ?,
                    modified_by = 'import_swing_expansion',
                    version = version + 1
                FROM swing_stage s
                WHERE workspace_mappings.legacy_item_id = s.item
                  AND workspace_mappings.legacy_feature_id = s.feature
                  AND workspace_mappings.legacy_value = s.value
                """,
                (now, now),
            )
            updated = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else matched
            raw.commit()

        cur.execute("DROP TABLE IF EXISTS swing_stage")
        raw.commit()
    except Exception:
        try:
            raw.rollback()
        except Exception:
            pass
        raise
    finally:
        raw.close()

    report(phase="done", processed_items=processed_items, total_items=total_items)

    return {
        "dryRun": dry_run,
        "totalItems": total_items,
        "totalExpandedRows": total_rows,
        "matched": matched,
        "updated": updated,
        "counts": counts,
        "parseFailures": counts.get("Review", 0),
    }
