"""Standalone ML classification prediction service.

A lightweight FastAPI service that exposes only the /predict and /health
endpoints.  Model artifacts are read from ../ml_service/model/ and training
data (for synonym-assist) from ../ml_service/training_data_template.csv so
that this service is fully decoupled from the Creo Gateway that lives in
../ml_service/.
"""

import csv
import json
import math
import os
import re
import secrets
from datetime import datetime, timezone
from importlib.util import find_spec
from pathlib import Path
from typing import Any, Dict, List, Optional

import joblib
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SERVICE_DIR = Path(__file__).resolve().parent
ENV_PATH = SERVICE_DIR / ".env"

# Shared model artifacts live in the sibling ml_service directory
ML_SERVICE_DIR = SERVICE_DIR.parent / "ml_service"
MODEL_PATH = ML_SERVICE_DIR / "model" / "model.joblib"
METADATA_PATH = ML_SERVICE_DIR / "model" / "metadata.json"
TRAINING_DATA_PATH = ML_SERVICE_DIR / "training_data_template.csv"

# ---------------------------------------------------------------------------
# .env helpers (auto-generate API_KEY on first run)
# ---------------------------------------------------------------------------
ENV_DEFAULTS: Dict[str, str] = {"API_KEY": ""}


def parse_env_file() -> Dict[str, str]:
    values = dict(ENV_DEFAULTS)
    if not ENV_PATH.exists():
        return values
    for raw_line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line == "" or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def write_env_file(values: Dict[str, str]) -> None:
    lines = [f"API_KEY={values.get('API_KEY', '')}"]
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def ensure_env_file() -> Dict[str, str]:
    values = parse_env_file()
    changed = False
    if not values.get("API_KEY", ""):
        values["API_KEY"] = secrets.token_urlsafe(32)
        changed = True
    if changed or not ENV_PATH.exists():
        write_env_file(values)
    return values


ENV_CONFIG = ensure_env_file()
load_dotenv(ENV_PATH)
API_KEY = ENV_CONFIG.get("API_KEY", "") or os.environ.get("API_KEY", "")

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="ML Classification Prediction Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_api_key(request: Request, call_next):
    if not API_KEY or request.url.path not in {"/predict", "/suggest-targets"}:
        return await call_next(request)
    auth_header = request.headers.get("Authorization", "")
    if auth_header != f"Bearer {API_KEY}":
        return JSONResponse(status_code=401, content={"detail": "Invalid or missing API key."})
    return await call_next(request)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------
class PredictRequest(BaseModel):
    description: Optional[str] = None
    availableClasses: Optional[List[str]] = None
    topK: int = 3
    prompt: Optional[str] = None
    useSynonymAssist: bool = False
    synonymThreshold: float = 0.8
    synonymWeight: float = 0.35


class TargetCandidate(BaseModel):
    id: str
    name: Optional[str] = None


class TargetFeature(BaseModel):
    key: str
    description: Optional[str] = None


class SuggestTargetsRequest(BaseModel):
    items: List[TargetFeature]
    candidates: List[TargetCandidate]
    topK: int = 3
    threshold: float = 0.0


# ---------------------------------------------------------------------------
# Global model state
# ---------------------------------------------------------------------------
pipeline = None
model_metadata = None
synonym_examples_by_class = None


# ---------------------------------------------------------------------------
# Text normalisation helpers
# ---------------------------------------------------------------------------
def normalize_label(value: str) -> str:
    raw = str(value or "").strip().lower()
    return re.sub(r"[^a-z0-9]+", "", raw)


def tokenize_text(value: str) -> List[str]:
    text = str(value or "").strip()
    if text == "":
        return []
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
    text = re.sub(r"[^a-zA-Z0-9]+", " ", text.lower()).strip()
    if text == "":
        return []
    parts = [item for item in text.split() if len(item) > 1]
    seen: set = set()
    unique: List[str] = []
    for part in parts:
        if part in seen:
            continue
        seen.add(part)
        unique.append(part)
    return unique


def token_overlap_score(left: List[str], right: List[str]) -> float:
    if not left or not right:
        return 0.0
    right_set = set(right)
    hit = sum(1 for token in left if token in right_set)
    denom = max(1, min(len(left), len(right)))
    score = hit / denom
    return max(0.0, min(1.0, float(score)))


def compute_synonym_score(description: str, class_name: str, examples: Optional[List[str]]) -> float:
    desc_tokens = tokenize_text(description)
    if not desc_tokens:
        return 0.0
    best = token_overlap_score(desc_tokens, tokenize_text(class_name))
    if examples:
        for sample in examples:
            score = token_overlap_score(desc_tokens, tokenize_text(sample))
            if score > best:
                best = score
            if best >= 0.999:
                break
    return max(0.0, min(1.0, float(best)))


# ---------------------------------------------------------------------------
# Model & metadata helpers
# ---------------------------------------------------------------------------
def ensure_model_loaded() -> None:
    global pipeline
    if pipeline is not None:
        return
    if not MODEL_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail=(
                "Model not found. Train first with train_model.py and place artifacts under "
                f"{MODEL_PATH.parent}"
            ),
        )
    try:
        pipeline = joblib.load(MODEL_PATH)
    except ModuleNotFoundError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Model dependencies are missing in the active Python environment. "
                "Install the required packages from ml_service/requirements.txt "
                f"using a Python version supported by scikit-learn. Missing module: {exc.name}"
            ),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Model artifact could not be loaded: {exc}",
        ) from exc


def get_model_metadata() -> dict:
    global model_metadata
    if model_metadata is not None:
        return model_metadata
    if METADATA_PATH.exists():
        try:
            with METADATA_PATH.open("r", encoding="utf-8") as fh:
                model_metadata = json.load(fh)
                return model_metadata
        except Exception:
            pass
    model_metadata = {}
    return model_metadata


def get_model_version() -> str:
    metadata = get_model_metadata()
    if isinstance(metadata, dict):
        for key in ["model_version", "trained_at", "created_at", "timestamp"]:
            value = metadata.get(key)
            if value:
                return str(value)
    if MODEL_PATH.exists():
        modified = datetime.fromtimestamp(MODEL_PATH.stat().st_mtime, tz=timezone.utc)
        return modified.strftime("%Y-%m-%dT%H:%M:%SZ")
    return "unknown"


def get_catalog_classes_from_metadata() -> List[str]:
    metadata = get_model_metadata()
    if not isinstance(metadata, dict):
        return []
    catalog = metadata.get("class_catalog")
    if not isinstance(catalog, dict):
        return []
    values = catalog.get("available_classes")
    if not isinstance(values, list):
        return []
    return [str(item).strip() for item in values if str(item).strip() != ""]


def model_runtime_ready() -> bool:
    return find_spec("sklearn") is not None


# ---------------------------------------------------------------------------
# Synonym examples loader
# ---------------------------------------------------------------------------
def load_synonym_examples() -> dict:
    global synonym_examples_by_class
    if synonym_examples_by_class is not None:
        return synonym_examples_by_class

    examples_map: Dict[str, List[str]] = {}
    seen_per_class: Dict[str, set] = {}
    if not TRAINING_DATA_PATH.exists():
        synonym_examples_by_class = examples_map
        return examples_map

    try:
        with TRAINING_DATA_PATH.open("r", encoding="utf-8-sig", newline="") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                if not row:
                    continue
                description = str(row.get("description") or "").strip()
                class_name = str(row.get("class") or "").strip()
                if description == "" or class_name == "":
                    continue
                key = class_name.lower()
                if key not in examples_map:
                    examples_map[key] = []
                    seen_per_class[key] = set()
                desc_key = description.lower()
                if desc_key in seen_per_class[key]:
                    continue
                seen_per_class[key].add(desc_key)
                if len(examples_map[key]) < 60:
                    examples_map[key].append(description)
    except Exception:
        examples_map = {}

    synonym_examples_by_class = examples_map
    return examples_map


# ---------------------------------------------------------------------------
# Synonym assist
# ---------------------------------------------------------------------------
def apply_synonym_assist(
    suggestions: List[dict],
    description: str,
    available_classes: Optional[List[str]],
    top_k: int,
    threshold: float,
    weight: float,
) -> List[dict]:
    if not suggestions:
        suggestions = []
    if description.strip() == "":
        return suggestions[: max(1, int(top_k))]

    threshold = max(0.0, min(1.0, float(threshold)))
    weight = max(0.0, min(1.0, float(weight)))

    ensure_model_loaded()
    examples_map = load_synonym_examples()

    merged: List[dict] = []
    by_key: Dict[str, dict] = {}
    for item in suggestions:
        class_name = str(item.get("className") or "").strip()
        if class_name == "":
            continue
        key = class_name.lower()
        if key in by_key:
            continue
        confidence = max(0.0, min(1.0, float(item.get("confidence") or 0.0)))
        normalized_item = {"className": class_name, "confidence": confidence}
        by_key[key] = normalized_item
        merged.append(normalized_item)

    if available_classes:
        candidates = [str(item).strip() for item in available_classes if str(item).strip() != ""]
    else:
        candidates = [str(label) for label in getattr(pipeline, "classes_", [])]

    for candidate in candidates:
        if candidate == "":
            continue
        key = candidate.lower()
        syn_score = compute_synonym_score(description, candidate, examples_map.get(key, []))
        if syn_score < threshold:
            continue
        existing = by_key.get(key)
        if existing is not None:
            existing_conf = float(existing.get("confidence") or 0.0)
            boosted_conf = ((1.0 - weight) * existing_conf) + (weight * syn_score)
            existing["confidence"] = max(existing_conf, boosted_conf)
        else:
            created = {"className": candidate, "confidence": max(0.01, weight * syn_score)}
            by_key[key] = created
            merged.append(created)

    merged.sort(key=lambda item: float(item.get("confidence") or 0.0), reverse=True)
    return merged[: max(1, int(top_k))]


# ---------------------------------------------------------------------------
# Core prediction
# ---------------------------------------------------------------------------
def to_suggestions(
    text: str,
    available_classes: Optional[List[str]],
    top_k: int,
    use_synonym_assist: bool,
    synonym_threshold: float,
    synonym_weight: float,
) -> List[dict]:
    ensure_model_loaded()

    clean = (text or "").strip()
    if clean == "":
        raise HTTPException(status_code=400, detail="description is required")

    probs = pipeline.predict_proba([clean])[0]
    labels = pipeline.classes_
    ranked = sorted(zip(labels, probs), key=lambda item: item[1], reverse=True)

    allowed = None
    allowed_normalized = None
    if available_classes:
        cleaned = [str(item).strip() for item in available_classes if str(item).strip() != ""]
        if cleaned:
            allowed = set(item.lower() for item in cleaned)
            allowed_normalized = set(normalize_label(item) for item in cleaned)

    suggestions: List[dict] = []
    for label, score in ranked:
        class_name = str(label)
        if allowed is not None:
            exact_ok = class_name.lower() in allowed
            normalized_ok = normalize_label(class_name) in allowed_normalized
            if not exact_ok and not normalized_ok:
                continue
        suggestions.append({"className": class_name, "confidence": float(score)})
        if len(suggestions) >= max(1, int(top_k)):
            break

    if len(suggestions) == 0:
        for label, score in ranked[: max(1, int(top_k))]:
            suggestions.append({"className": str(label), "confidence": float(score)})

    if use_synonym_assist:
        suggestions = apply_synonym_assist(
            suggestions=suggestions,
            description=clean,
            available_classes=available_classes,
            top_k=top_k,
            threshold=synonym_threshold,
            weight=synonym_weight,
        )

    return suggestions


def extract_description_from_prompt(prompt: str) -> str:
    text = prompt or ""
    marker = "Description:"
    idx = text.find(marker)
    if idx < 0:
        return ""
    after = text[idx + len(marker) :]
    split_markers = ["\nExisting Class:", "\nAvailable Classes:"]
    end = len(after)
    for split_marker in split_markers:
        split_idx = after.find(split_marker)
        if split_idx >= 0:
            end = min(end, split_idx)
    return after[:end].strip()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "modelLoaded": MODEL_PATH.exists(),
        "modelRuntimeReady": model_runtime_ready(),
        "modelPath": str(MODEL_PATH),
    }


@app.post("/predict")
def predict(body: PredictRequest) -> Dict[str, Any]:
    description = (body.description or "").strip()
    if description == "" and body.prompt:
        description = extract_description_from_prompt(body.prompt)
    if description == "" and body.prompt:
        description = (body.prompt or "").strip()

    catalog_classes = get_catalog_classes_from_metadata()
    effective_available_classes = catalog_classes
    if not effective_available_classes:
        ensure_model_loaded()
        effective_available_classes = [str(label) for label in getattr(pipeline, "classes_", [])]

    suggestions = to_suggestions(
        text=description,
        available_classes=effective_available_classes,
        top_k=body.topK,
        use_synonym_assist=body.useSynonymAssist,
        synonym_threshold=body.synonymThreshold,
        synonym_weight=body.synonymWeight,
    )

    top_prediction = suggestions[0]["className"] if suggestions else None
    return {
        "topPrediction": top_prediction,
        "suggestions": suggestions,
        "provider": "local-ml",
        "modelVersion": get_model_version(),
        "classSource": "metadata.class_catalog" if catalog_classes else "model.classes_",
    }


# Small synonym groups so semantically-equal ERP terms match (e.g. type <-> style).
SYNONYM_GROUPS: List[set] = [
    {"type", "style", "kind", "variant"},
    {"color", "colour"},
    {"quantity", "qty", "count", "number", "num"},
    {"length", "len"},
    {"width", "wide"},
    {"height", "tall"},
    {"material", "mat"},
    {"diameter", "dia"},
]


def _expand_synonyms(token: str) -> set:
    expanded = {token}
    for group in SYNONYM_GROUPS:
        if token in group:
            expanded |= group
    return expanded


@app.post("/suggest-targets")
def suggest_targets(body: SuggestTargetsRequest) -> Dict[str, Any]:
    """IDF-weighted, synonym-aware text matching of features against candidate targets."""
    threshold = max(0.0, min(1.0, float(body.threshold)))
    top_k = max(1, int(body.topK))

    candidate_index: List[Dict[str, Any]] = []
    for candidate in body.candidates:
        target_id = str(candidate.id or "").strip()
        if target_id == "":
            continue
        text = f"{target_id} {candidate.name or ''}"
        candidate_index.append({
            "id": target_id,
            "tokens": tokenize_text(text),
            "normalized": normalize_label(text),
        })

    n_candidates = max(1, len(candidate_index))

    results: Dict[str, List[Dict[str, Any]]] = {}
    for feature in body.items:
        key = str(feature.key or "").strip()
        if key == "":
            continue
        description = feature.description or ""
        desc_tokens = tokenize_text(description)
        desc_normalized = normalize_label(description)

        # Distinctive tokens (e.g. "arm") weigh more than common ones (e.g. "type");
        # synonyms count toward a token's match so "type" also matches "style".
        token_synonyms = {t: _expand_synonyms(t) for t in desc_tokens}
        idf: Dict[str, float] = {}
        for t in desc_tokens:
            df = sum(
                1 for cand in candidate_index
                if any(syn and syn in cand["normalized"] for syn in token_synonyms[t])
            )
            idf[t] = math.log((n_candidates + 1.0) / (df + 1.0)) + 1.0
        total_idf = sum(idf.values()) or 1.0

        scored: List[Dict[str, Any]] = []
        for candidate in candidate_index:
            cand_norm = candidate["normalized"]
            if desc_normalized and desc_normalized == cand_norm:
                score = 1.0
            elif desc_tokens and cand_norm:
                matched = sum(
                    idf[t] for t in desc_tokens
                    if any(syn and syn in cand_norm for syn in token_synonyms[t])
                )
                score = matched / total_idf
            else:
                score = 0.0
            score = max(0.0, min(1.0, float(score)))
            if score < threshold:
                continue
            scored.append({"targetId": candidate["id"], "confidence": round(score, 4)})
        scored.sort(key=lambda item: item["confidence"], reverse=True)
        results[key] = scored[:top_k]

    return {"results": results, "provider": "local-ml", "modelVersion": get_model_version()}
