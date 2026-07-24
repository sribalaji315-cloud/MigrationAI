import contextlib
import csv
import io
import json
import logging
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import Response

from ..core.security import get_current_user
from ..db import models

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from import_from_sqlite import _load_config
from import_swing_feasibility_conditions import run_import

from ..services.swing.runner import run_swing_expansion

logger = logging.getLogger("erp_migrator")

router = APIRouter(prefix="/imports", tags=["imports"])


def _require_admin(current_user: models.User) -> None:
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required",
        )


@router.post("/swing-feasibility")
def import_swing_feasibility(
    dry_run: bool = Query(False, alias="dryRun"),
    current_user: models.User = Depends(get_current_user),
):
    _require_admin(current_user)

    config_path = _BACKEND_ROOT / "import_config_swing_feasibility.json"
    if not config_path.exists():
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Import config not found: {config_path}",
        )

    output = io.StringIO()
    try:
        cfg = _load_config(str(config_path))
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            run_import(cfg, dry_run=dry_run)
    except SystemExit as exc:
        message = str(exc) or output.getvalue().strip() or "Swing feasibility import failed"
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=message) from exc
    except Exception as exc:
        detail = output.getvalue().strip()
        if detail:
            detail = f"{detail}\n{exc}"
        else:
            detail = str(exc)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=detail) from exc

    return {
        "ok": True,
        "dryRun": dry_run,
        "sourceDbPath": cfg.get("source_db_path"),
        "summary": output.getvalue().strip(),
    }


# ---------------------------------------------------------------------------
# Swing expansion from raw PowerBI xlsx (item config + group features).
#
# Computes feasibility/condition with the ported engine and updates ONLY the
# feasibility/condition columns on existing workspace_mappings rows. Runs as a
# background job because the expansion can reach millions of rows.
# ---------------------------------------------------------------------------
def _new_swing_job() -> dict:
    return {
        "status": "idle",  # idle | queued | running | completed | failed
        "phase": None,     # parsing | expanding | staging | applying | done
        "progress": 0.0,
        "totalItems": 0,
        "processedItems": 0,
        "stagedRows": 0,
        "matched": 0,
        "updated": 0,
        "counts": {"Yes": 0, "No": 0, "Conditional": 0, "Review": 0},
        "parseFailures": 0,
        "dryRun": False,
        "error": None,
        "startedAt": None,
        "finishedAt": None,
    }


_swing_job: dict = _new_swing_job()
_swing_lock = threading.Lock()


def _save_upload_temp(data: bytes, suffix: str = ".xlsx") -> str:
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="swing_")
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return path


def _run_swing_job(item_path: str, group_path: str, dry_run: bool) -> None:
    with _swing_lock:
        _swing_job.update(_new_swing_job())
        _swing_job.update(
            {"status": "running", "phase": "parsing", "dryRun": dry_run, "startedAt": time.time()}
        )

    def cb(**kwargs) -> None:
        with _swing_lock:
            if "phase" in kwargs:
                _swing_job["phase"] = kwargs["phase"]
            if "total_items" in kwargs:
                _swing_job["totalItems"] = kwargs["total_items"]
            if "processed_items" in kwargs:
                _swing_job["processedItems"] = kwargs["processed_items"]
                total = _swing_job["totalItems"]
                if total:
                    _swing_job["progress"] = min(0.99, kwargs["processed_items"] / total)
            if "staged_rows" in kwargs:
                _swing_job["stagedRows"] = kwargs["staged_rows"]

    try:
        summary = run_swing_expansion(item_path, group_path, dry_run=dry_run, progress_cb=cb)
        with _swing_lock:
            _swing_job.update(
                {
                    "status": "completed",
                    "phase": "done",
                    "progress": 1.0,
                    "totalItems": summary["totalItems"],
                    "processedItems": summary["totalItems"],
                    "stagedRows": summary["totalExpandedRows"],
                    "matched": summary["matched"],
                    "updated": summary["updated"],
                    "counts": summary["counts"],
                    "parseFailures": summary["parseFailures"],
                    "finishedAt": time.time(),
                }
            )
    except Exception as exc:  # noqa: BLE001 — surface the failure to the client
        logger.exception("Swing expansion job failed")
        with _swing_lock:
            _swing_job.update({"status": "failed", "error": str(exc), "finishedAt": time.time()})
    finally:
        for path in (item_path, group_path):
            try:
                os.remove(path)
            except OSError:
                pass


@router.post("/swing-expansion")
async def upload_and_run_swing_expansion(
    item_file: UploadFile = File(...),
    group_file: UploadFile = File(...),
    dry_run: bool = Query(False, alias="dryRun"),
    current_user: models.User = Depends(get_current_user),
):
    _require_admin(current_user)

    with _swing_lock:
        if _swing_job["status"] in ("queued", "running"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A swing expansion job is already running.",
            )
        _swing_job.update(_new_swing_job())
        _swing_job.update({"status": "queued", "phase": "queued", "dryRun": dry_run})

    item_bytes = await item_file.read()
    group_bytes = await group_file.read()
    item_path = _save_upload_temp(item_bytes)
    group_path = _save_upload_temp(group_bytes)

    thread = threading.Thread(
        target=_run_swing_job, args=(item_path, group_path, dry_run), daemon=True
    )
    thread.start()

    return {"ok": True, "status": "queued", "dryRun": dry_run}


@router.get("/swing-expansion/progress")
def swing_expansion_progress(current_user: models.User = Depends(get_current_user)):
    _require_admin(current_user)
    with _swing_lock:
        job = dict(_swing_job)
        job["counts"] = dict(_swing_job["counts"])
    job["isActive"] = job["status"] in ("queued", "running")
    return job


# ---------------------------------------------------------------------------
# Item-features CSV import (NEW, isolated path).
#
# Imports a large (~300k row) "item features" CSV into bom_items + bom_features,
# aggregating models away (see import_item_features_csv.run_import). Runs as a
# background job so the request returns immediately and the client polls
# progress. This does NOT touch the existing dual-file feature import or /sync.
# ---------------------------------------------------------------------------
def _new_item_features_job() -> dict:
    return {
        "status": "idle",  # idle | queued | running | completed | failed
        "phase": None,     # parsing | inserting | done
        "progress": 0.0,
        "processedRows": 0,
        "totalRows": 0,
        "processedItems": 0,
        "totalItems": 0,
        "createdItems": 0,
        "createdFeatures": 0,
        "updatedItems": 0,
        "addedFeatures": 0,
        "addedValues": 0,
        "unchangedItems": 0,
        "_updatedReport": [],
        "rowsSkippedEmpty": 0,
        "dryRun": False,
        "error": None,
        "summary": None,
        "startedAt": None,
        "finishedAt": None,
    }


_item_features_job: dict = _new_item_features_job()
_item_features_lock = threading.Lock()


def _run_item_features_job(csv_path: str, column_mapping: dict | None, dry_run: bool) -> None:
    from import_item_features_csv import run_import as run_item_features_import

    with _item_features_lock:
        _item_features_job.update(_new_item_features_job())
        _item_features_job.update(
            {"status": "running", "phase": "parsing", "dryRun": dry_run, "startedAt": time.time()}
        )

    def cb(**kwargs) -> None:
        with _item_features_lock:
            phase = kwargs.get("phase")
            if phase:
                _item_features_job["phase"] = phase
            if "processed_rows" in kwargs:
                _item_features_job["processedRows"] = kwargs["processed_rows"]
            if "processed_items" in kwargs:
                _item_features_job["processedItems"] = kwargs["processed_items"]
            if "total_items" in kwargs:
                _item_features_job["totalItems"] = kwargs["total_items"]
            if "created_items" in kwargs:
                _item_features_job["createdItems"] = kwargs["created_items"]
            if "created_features" in kwargs:
                _item_features_job["createdFeatures"] = kwargs["created_features"]
            if "updated_items" in kwargs:
                _item_features_job["updatedItems"] = kwargs["updated_items"]
            if "added_features" in kwargs:
                _item_features_job["addedFeatures"] = kwargs["added_features"]
            if "added_values" in kwargs:
                _item_features_job["addedValues"] = kwargs["added_values"]
            # Coarse progress: parsing counts as the first half, inserting the second.
            if phase == "inserting":
                total = _item_features_job["totalItems"]
                done = _item_features_job["processedItems"]
                frac = (done / total) if total else 0.0
                _item_features_job["progress"] = min(0.99, 0.5 + 0.5 * frac)
            elif phase == "parsing":
                _item_features_job["progress"] = min(0.49, _item_features_job["progress"] + 0.01)

    try:
        summary = run_item_features_import(
            csv_path, dry_run=dry_run, column_mapping=column_mapping, progress_cb=cb
        )
        updated_report = summary["updated_report"]
        # Keep the polling payload small: store the full report separately for the
        # download endpoint and expose only aggregate counts via /progress.
        trimmed_summary = {k: v for k, v in summary.items() if k != "updated_report"}
        with _item_features_lock:
            _item_features_job.update(
                {
                    "status": "completed",
                    "phase": "done",
                    "progress": 1.0,
                    "totalRows": summary["total_rows"],
                    "processedRows": summary["total_rows"],
                    "createdItems": summary["created_items"],
                    "createdFeatures": summary["created_features"],
                    "updatedItems": summary["updated_items"],
                    "addedFeatures": summary["added_features"],
                    "addedValues": summary["added_values"],
                    "unchangedItems": summary["unchanged_items"],
                    "_updatedReport": updated_report,
                    "rowsSkippedEmpty": summary["rows_skipped_empty"],
                    "summary": trimmed_summary,
                    "finishedAt": time.time(),
                }
            )
    except Exception as exc:  # noqa: BLE001 — surface the failure to the client
        logger.exception("Item-features import job failed")
        with _item_features_lock:
            _item_features_job.update(
                {"status": "failed", "error": str(exc), "finishedAt": time.time()}
            )
    finally:
        try:
            os.remove(csv_path)
        except OSError:
            pass


@router.post("/item-features")
async def upload_and_import_item_features(
    file: UploadFile = File(...),
    columnMapping: str | None = Form(default=None),
    dry_run: bool = Query(False, alias="dryRun"),
    current_user: models.User = Depends(get_current_user),
):
    _require_admin(current_user)

    # Parse the optional column-mapping JSON up-front so bad input fails fast.
    parsed_mapping: dict | None = None
    if columnMapping:
        try:
            parsed_mapping = json.loads(columnMapping)
        except (ValueError, TypeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid columnMapping JSON: {exc}",
            ) from exc
        if not isinstance(parsed_mapping, dict):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="columnMapping must be a JSON object",
            )

    with _item_features_lock:
        if _item_features_job["status"] in ("queued", "running"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="An item-features import job is already running.",
            )
        _item_features_job.update(_new_item_features_job())
        _item_features_job.update({"status": "queued", "phase": "queued", "dryRun": dry_run})

    data = await file.read()
    csv_path = _save_upload_temp(data, suffix=".csv")

    thread = threading.Thread(
        target=_run_item_features_job, args=(csv_path, parsed_mapping, dry_run), daemon=True
    )
    thread.start()

    return {"ok": True, "status": "queued", "dryRun": dry_run}


@router.get("/item-features/progress")
def item_features_progress(current_user: models.User = Depends(get_current_user)):
    _require_admin(current_user)
    with _item_features_lock:
        job = dict(_item_features_job)
    job.pop("_updatedReport", None)  # never send the full report during polling
    job["isActive"] = job["status"] in ("queued", "running")
    return job


@router.get("/item-features/merge-report.csv")
def item_features_merge_report(current_user: models.User = Depends(get_current_user)):
    _require_admin(current_user)
    with _item_features_lock:
        report = list(_item_features_job.get("_updatedReport", []))
        dry_run = _item_features_job.get("dryRun", False)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["item_id", "features_added", "values_added"])
    for row in report:
        writer.writerow([row.get("item_id", ""), row.get("added_features", 0), row.get("added_values", 0)])

    filename = "item-features-merge-report-dryrun.csv" if dry_run else "item-features-merge-report.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
