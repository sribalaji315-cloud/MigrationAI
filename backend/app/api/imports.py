import contextlib
import io
import sys
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ..core.security import get_current_user
from ..db import models

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from import_from_sqlite import _load_config
from import_swing_feasibility_conditions import run_import

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
