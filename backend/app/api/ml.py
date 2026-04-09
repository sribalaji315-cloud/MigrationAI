"""ML classification integration endpoints.

Provides endpoints to predict classification for individual BOM items
or all items in bulk, using the external local ML service.
"""

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core.config import settings
from ..core.security import get_current_user
from ..db import models
from ..db.session import get_db, SessionLocal
from .websocket import manager

logger = logging.getLogger("erp_migrator")
router = APIRouter(prefix="/ml", tags=["ml"])


# ---------------------------------------------------------------------------
# In-memory prediction job tracker (mirrors the mapping-generation pattern)
# ---------------------------------------------------------------------------
_prediction_job: Dict[str, Any] = {
    "status": "idle",
    "progress": 0,
    "total": 0,
    "processed": 0,
    "error": None,
}
_prediction_lock = asyncio.Lock()

# Runtime-adjustable ML settings (initialised from config, mutated via API)
_ml_settings: Dict[str, Any] = {
    "useSynonymAssist": settings.ML_USE_SYNONYM_ASSIST,
    "synonymThreshold": settings.ML_SYNONYM_THRESHOLD,
    "synonymWeight": settings.ML_SYNONYM_WEIGHT,
}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------
class MLSettingsIn(BaseModel):
    useSynonymAssist: Optional[bool] = None
    synonymThreshold: Optional[float] = None
    synonymWeight: Optional[float] = None


class PredictionOut(BaseModel):
    classId: str
    className: str
    confidence: float


class PredictResponse(BaseModel):
    itemId: str
    predictions: List[PredictionOut]


class PredictAllStatusResponse(BaseModel):
    status: str
    progress: float
    total: int
    processed: int
    error: Optional[str] = None


class AssignClassificationRequest(BaseModel):
    classId: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_class_name_to_id_map(db: Session) -> Dict[str, str]:
    """Build a mapping from className (lowered) -> classId from the classifications table."""
    rows = db.query(models.Classification.class_id, models.Classification.class_name).all()
    return {row.class_name.lower(): row.class_id for row in rows if row.class_name}


async def _call_ml_service(description: str, top_k: int = 3) -> List[Dict[str, Any]]:
    """Call the external ML prediction service and return raw suggestions."""
    if not settings.ML_SERVICE_URL:
        raise HTTPException(status_code=503, detail="ML service URL not configured")

    headers: Dict[str, str] = {}
    if settings.ML_SERVICE_API_KEY:
        headers["Authorization"] = f"Bearer {settings.ML_SERVICE_API_KEY}"

    payload: Dict[str, Any] = {"description": description, "topK": top_k}
    if _ml_settings["useSynonymAssist"]:
        payload["useSynonymAssist"] = True
        payload["synonymThreshold"] = _ml_settings["synonymThreshold"]
        payload["synonymWeight"] = _ml_settings["synonymWeight"]

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{settings.ML_SERVICE_URL}/predict",
            json=payload,
            headers=headers,
        )
        if resp.status_code != 200:
            logger.error("ML service returned %s: %s", resp.status_code, resp.text[:500])
            raise HTTPException(status_code=502, detail=f"ML service error: {resp.status_code}")

        data = resp.json()
        return data.get("suggestions") or []


def _call_ml_service_sync(description: str, top_k: int = 3) -> List[Dict[str, Any]]:
    """Synchronous version of _call_ml_service for use in background threads."""
    if not settings.ML_SERVICE_URL:
        raise RuntimeError("ML service URL not configured")

    headers: Dict[str, str] = {}
    if settings.ML_SERVICE_API_KEY:
        headers["Authorization"] = f"Bearer {settings.ML_SERVICE_API_KEY}"

    payload: Dict[str, Any] = {"description": description, "topK": top_k}
    if _ml_settings["useSynonymAssist"]:
        payload["useSynonymAssist"] = True
        payload["synonymThreshold"] = _ml_settings["synonymThreshold"]
        payload["synonymWeight"] = _ml_settings["synonymWeight"]

    with httpx.Client(timeout=30.0) as client:
        resp = client.post(
            f"{settings.ML_SERVICE_URL}/predict",
            json=payload,
            headers=headers,
        )
        if resp.status_code != 200:
            logger.error("ML service returned %s: %s", resp.status_code, resp.text[:500])
            raise RuntimeError(f"ML service error: {resp.status_code}")

        data = resp.json()
        return data.get("suggestions") or []


def _resolve_predictions(
    suggestions: List[Dict[str, Any]],
    name_to_id: Dict[str, str],
) -> List[Dict[str, Any]]:
    """Map ML className responses to our classId using the classifications table."""
    results: List[Dict[str, Any]] = []
    for s in suggestions:
        class_name = s.get("className", "")
        confidence = s.get("confidence", 0)
        class_id = name_to_id.get(class_name.lower(), class_name)
        results.append({
            "classId": class_id,
            "className": class_name,
            "confidence": round(confidence, 4),
        })
    return results


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/settings")
async def get_ml_settings(
    current_user: models.User = Depends(get_current_user),
):
    """Return current runtime ML settings."""
    return dict(_ml_settings)


@router.put("/settings")
async def update_ml_settings(
    body: MLSettingsIn,
    current_user: models.User = Depends(get_current_user),
):
    """Update runtime ML settings (admin only)."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    if body.useSynonymAssist is not None:
        _ml_settings["useSynonymAssist"] = body.useSynonymAssist
    if body.synonymThreshold is not None:
        if not 0 <= body.synonymThreshold <= 1:
            raise HTTPException(status_code=422, detail="synonymThreshold must be between 0 and 1")
        _ml_settings["synonymThreshold"] = round(body.synonymThreshold, 2)
    if body.synonymWeight is not None:
        if not 0 <= body.synonymWeight <= 1:
            raise HTTPException(status_code=422, detail="synonymWeight must be between 0 and 1")
        _ml_settings["synonymWeight"] = round(body.synonymWeight, 2)
    return dict(_ml_settings)


@router.post("/predict/{item_id}", response_model=PredictResponse)
async def predict_single(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Predict classification for a single BOM item using the ML service."""
    bom_item = db.query(models.BomItem).filter(models.BomItem.item_id == item_id).first()
    if not bom_item:
        raise HTTPException(status_code=404, detail=f"BOM item '{item_id}' not found")

    description = bom_item.description or ""
    if not description.strip():
        raise HTTPException(status_code=400, detail="Item has no description to classify")

    suggestions = await _call_ml_service(description)
    name_to_id = _build_class_name_to_id_map(db)
    predictions = _resolve_predictions(suggestions, name_to_id)

    # Persist to DB
    bom_item.ml_predictions = predictions
    db.commit()

    return PredictResponse(itemId=item_id, predictions=[PredictionOut(**p) for p in predictions])


@router.post("/predict-all", response_model=PredictAllStatusResponse)
async def predict_all(
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Trigger ML prediction for all BOM items as a background job."""
    async with _prediction_lock:
        if _prediction_job["status"] in ("running", "queued"):
            return PredictAllStatusResponse(**{
                "status": _prediction_job["status"],
                "progress": _prediction_job["progress"],
                "total": _prediction_job["total"],
                "processed": _prediction_job["processed"],
                "error": _prediction_job["error"],
            })

        total = db.query(models.BomItem).count()
        _prediction_job.update({
            "status": "queued",
            "progress": 0,
            "total": total,
            "processed": 0,
            "error": None,
        })

    background_tasks.add_task(_run_predict_all)

    return PredictAllStatusResponse(**{
        "status": "queued",
        "progress": 0,
        "total": total,
        "processed": 0,
        "error": None,
    })


@router.get("/predict-all/status", response_model=PredictAllStatusResponse)
async def predict_all_status(
    current_user: models.User = Depends(get_current_user),
):
    """Get the current status of the predict-all background job."""
    return PredictAllStatusResponse(**{
        "status": _prediction_job["status"],
        "progress": _prediction_job["progress"],
        "total": _prediction_job["total"],
        "processed": _prediction_job["processed"],
        "error": _prediction_job["error"],
    })


@router.put("/classify/{item_id}")
async def assign_classification(
    item_id: str,
    body: AssignClassificationRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Assign a classification to a BOM item (writes to the classification column)."""
    bom_item = db.query(models.BomItem).filter(models.BomItem.item_id == item_id).first()
    if not bom_item:
        raise HTTPException(status_code=404, detail=f"BOM item '{item_id}' not found")

    class_id = body.classId
    if class_id == "UNCLASSIFIED":
        class_id = None

    bom_item.classification = class_id
    db.commit()

    return {"ok": True, "itemId": item_id, "classification": bom_item.classification}


# ---------------------------------------------------------------------------
# Background worker for predict-all (offloaded to thread to avoid blocking
# the asyncio event loop with synchronous DB calls)
# ---------------------------------------------------------------------------

def _run_predict_all_sync(loop: asyncio.AbstractEventLoop):
    """Synchronous worker that runs in a thread via run_in_executor.

    All DB operations and ML HTTP calls are synchronous so the main event
    loop stays free for other requests (login, status checks, etc.).
    WebSocket broadcasts are dispatched back to the event loop via
    asyncio.run_coroutine_threadsafe.
    """
    global _prediction_job

    _prediction_job["status"] = "running"

    db = SessionLocal()
    try:
        all_items = db.query(models.BomItem.id, models.BomItem.item_id, models.BomItem.description).all()
        total = len(all_items)
        _prediction_job["total"] = total
        name_to_id = _build_class_name_to_id_map(db)

        for idx, (pk, item_id, description) in enumerate(all_items):
            try:
                if description and description.strip():
                    suggestions = _call_ml_service_sync(description)
                    predictions = _resolve_predictions(suggestions, name_to_id)
                else:
                    predictions = []

                db.query(models.BomItem).filter(models.BomItem.id == pk).update(
                    {"ml_predictions": predictions}
                )
                if (idx + 1) % 50 == 0 or idx == total - 1:
                    db.commit()

            except Exception as exc:
                logger.warning("ML prediction failed for item %s: %s", item_id, exc)

            processed = idx + 1
            progress = processed / total if total > 0 else 1
            _prediction_job["processed"] = processed
            _prediction_job["progress"] = round(progress, 4)

            # Broadcast progress via WebSocket every 10 items
            if processed % 10 == 0 or processed == total:
                try:
                    asyncio.run_coroutine_threadsafe(
                        manager.broadcast("ml_prediction_progress", {
                            "status": "running",
                            "progress": round(progress, 4),
                            "total": total,
                            "processed": processed,
                        }),
                        loop,
                    )
                except Exception:
                    pass

        db.commit()
        _prediction_job["status"] = "completed"
        _prediction_job["progress"] = 1

        try:
            asyncio.run_coroutine_threadsafe(
                manager.broadcast("ml_prediction_progress", {
                    "status": "completed",
                    "progress": 1,
                    "total": total,
                    "processed": total,
                }),
                loop,
            )
        except Exception:
            pass

    except Exception as exc:
        logger.error("Predict-all job failed: %s", exc, exc_info=True)
        _prediction_job["status"] = "failed"
        _prediction_job["error"] = str(exc)[:500]
        try:
            asyncio.run_coroutine_threadsafe(
                manager.broadcast("ml_prediction_progress", {
                    "status": "failed",
                    "error": str(exc)[:500],
                }),
                loop,
            )
        except Exception:
            pass
    finally:
        db.close()


async def _run_predict_all():
    """Thin async wrapper that offloads the predict-all work to a thread."""
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _run_predict_all_sync, loop)
