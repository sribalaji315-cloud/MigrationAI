import contextlib
import io
import logging
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status

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
