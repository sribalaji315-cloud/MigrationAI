import asyncio
import csv
import json
import os
import re
import secrets
from datetime import datetime, timezone
from importlib.util import find_spec
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

import joblib
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

SERVICE_DIR = Path(__file__).resolve().parent
ENV_PATH = SERVICE_DIR / ".env"
STATIC_DIR = SERVICE_DIR / "static"

ENV_DEFAULTS = {
    "API_KEY": "",
    "LOCAL_PORT": "8000",
    "ALLOWED_ORIGIN": "",
}


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
    lines = []
    for key in ("API_KEY", "LOCAL_PORT", "ALLOWED_ORIGIN"):
        lines.append(f"{key}={values.get(key, ENV_DEFAULTS.get(key, ''))}")
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def ensure_env_file() -> Dict[str, str]:
    values = parse_env_file()
    changed = False
    if values.get("API_KEY", "") == "":
        values["API_KEY"] = secrets.token_urlsafe(32)
        changed = True
    local_port = str(values.get("LOCAL_PORT", ENV_DEFAULTS["LOCAL_PORT"]) or ENV_DEFAULTS["LOCAL_PORT"]).strip()
    if not local_port.isdigit():
        values["LOCAL_PORT"] = ENV_DEFAULTS["LOCAL_PORT"]
        changed = True
    if "ALLOWED_ORIGIN" not in values:
        values["ALLOWED_ORIGIN"] = ENV_DEFAULTS["ALLOWED_ORIGIN"]
        changed = True
    if changed or not ENV_PATH.exists():
        write_env_file(values)
    return values

ENV_CONFIG = ensure_env_file()
load_dotenv(ENV_PATH)
API_KEY = ENV_CONFIG.get("API_KEY", "") or os.environ.get("API_KEY", "")
ALLOWED_ORIGIN = ENV_CONFIG.get("ALLOWED_ORIGIN", "") or os.environ.get("ALLOWED_ORIGIN", "")
LOCAL_PORT = ENV_CONFIG.get("LOCAL_PORT", ENV_DEFAULTS["LOCAL_PORT"])

WORKSPACE_DIR = SERVICE_DIR.parent
MODEL_PATH = SERVICE_DIR / "model" / "model.joblib"
METADATA_PATH = SERVICE_DIR / "model" / "metadata.json"
TRAINING_DATA_PATH = SERVICE_DIR / "training_data_template.csv"
WORKSPACE_JS_DIR = WORKSPACE_DIR / "js"
WORKSPACE_CSS_DIR = WORKSPACE_DIR / "css"
DEFAULT_EBOM_SCAN_DIR = Path(r"C:\myloadpoint\creo automation\proprogram")
GATEWAY_LOG_PATH = WORKSPACE_DIR / "creo_batch_import_debug.log"

app = FastAPI(title="Creo Gateway and Local Classification Service", version="1.2.0")

allow_origins_list = [origin.strip() for origin in ALLOWED_ORIGIN.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def is_protected_path(path: str, method: str = "GET") -> bool:
    if path == "/predict":
        return True
    if not path.startswith("/api/"):
        return False
    # Reading status/config exposes no secret; only mutating local config
    # (which rewrites CORS/port in .env) and all other /api/ routes need the key.
    if path in ("/api/local/status", "/api/local/config") and method.upper() in ("GET", "HEAD", "OPTIONS"):
        return False
    return True


@app.middleware("http")
async def require_api_key(request: Request, call_next):
    if not API_KEY or not is_protected_path(request.url.path, request.method):
        return await call_next(request)

    auth_header = request.headers.get("Authorization", "")
    if auth_header != f"Bearer {API_KEY}":
        return JSONResponse(status_code=401, content={"detail": "Invalid or missing API key."})

    return await call_next(request)


class PredictRequest(BaseModel):
    description: Optional[str] = None
    availableClasses: Optional[List[str]] = None
    topK: int = 3
    prompt: Optional[str] = None
    useSynonymAssist: bool = False
    synonymThreshold: float = 0.8
    synonymWeight: float = 0.35


class MacroRequest(BaseModel):
    macro: str
    workingDirectory: Optional[str] = None


class ParameterSetRequest(BaseModel):
    modelNameExt: str
    paramName: str
    paramType: Any = Field(..., description="Integer PWL type code or symbolic PWL constant name")
    rawValue: str = ""


class ParameterCreateRequest(ParameterSetRequest):
    pass


class ModelRequest(BaseModel):
    modelNameExt: str


class DirectoryRequest(BaseModel):
    directoryPath: str


class LogAppendRequest(BaseModel):
    message: str
    source: str = "ui"


class ClassificationSaveRequest(BaseModel):
    modelNameExt: str
    value: str = ""


class ProgramIoRequest(BaseModel):
    modelNameExt: str
    filePath: str
    forceCloseAfterImport: bool = False


class ProgramBatchRequest(BaseModel):
    directoryPath: str
    models: List[str] = Field(default_factory=list)
    parentModelNameExt: Optional[str] = None
    featureMap: Optional[dict] = None
    levelMap: Optional[dict] = None


class BomMacroRequest(BaseModel):
    macro: str
    workingDirectory: Optional[str] = None
    models: List[str] = Field(default_factory=list)
    parentModelNameExt: Optional[str] = None
    delayMs: int = 1500


class FeatureByIdRequest(BaseModel):
    modelNameExt: str
    featureId: int


class ProgramCleanRequest(BaseModel):
    directoryPath: str


class ProgramCleanFileRequest(BaseModel):
    filePath: str
    addPostrelationsBreak: bool = True


class EbomParseRequest(BaseModel):
    directoryPath: Optional[str] = None


class LocalConfigUpdateRequest(BaseModel):
    allowedOrigin: str = ""
    localPort: int = Field(default=8000, ge=1, le=65535)


pipeline = None
model_metadata = None
synonym_examples_by_class = None


class CreoBridgeState:
    def __init__(self) -> None:
        self.websocket: Optional[WebSocket] = None
        self.connected_at: Optional[str] = None
        self.client_name: Optional[str] = None
        self.capabilities: List[str] = []
        self.pending: Dict[str, asyncio.Future] = {}
        self.send_lock = asyncio.Lock()

    async def register(self, websocket: WebSocket) -> None:
        await websocket.accept()

        previous = self.websocket
        self.websocket = websocket
        self.connected_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.client_name = None
        self.capabilities = []

        if previous is not None and previous is not websocket:
            try:
                await previous.close(code=1012, reason="Superseded by a newer Creo bridge session")
            except Exception:
                pass

    async def unregister(self, websocket: WebSocket) -> None:
        if self.websocket is websocket:
            self.websocket = None
            self.connected_at = None
            self.client_name = None
            self.capabilities = []
            await self.fail_pending("Creo bridge disconnected.")

    async def fail_pending(self, message: str) -> None:
        pending = list(self.pending.items())
        self.pending = {}
        for _, future in pending:
            if future.done():
                continue
            future.set_exception(RuntimeError(message))

    def update_identity(self, payload: Dict[str, Any]) -> None:
        self.client_name = str(payload.get("client") or "Creo Embedded Browser")
        raw_capabilities = payload.get("capabilities")
        if isinstance(raw_capabilities, list):
            self.capabilities = [str(item) for item in raw_capabilities]

    def resolve(self, payload: Dict[str, Any]) -> None:
        request_id = str(payload.get("id") or "")
        if request_id == "":
            return

        future = self.pending.pop(request_id, None)
        if future is None or future.done():
            return

        future.set_result(payload)

    def status_payload(self) -> Dict[str, Any]:
        return {
            "connected": self.websocket is not None,
            "connectedAt": self.connected_at,
            "client": self.client_name,
            "capabilities": self.capabilities,
        }

    async def call(self, action: str, args: Optional[Dict[str, Any]] = None, timeout: float = 60.0) -> Any:
        if self.websocket is None:
            raise HTTPException(
                status_code=503,
                detail="Creo bridge is not connected. Open /creo_bridge.html inside the Creo embedded browser.",
            )

        request_id = uuid4().hex
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self.pending[request_id] = future

        try:
            async with self.send_lock:
                await self.websocket.send_json(
                    {
                        "type": "command",
                        "id": request_id,
                        "action": action,
                        "args": args or {},
                    }
                )

            payload = await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError as exc:
            self.pending.pop(request_id, None)
            raise HTTPException(status_code=504, detail=f"Timed out waiting for Creo bridge action '{action}'.") from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except Exception as exc:
            self.pending.pop(request_id, None)
            raise HTTPException(status_code=502, detail=f"Creo bridge call failed for '{action}': {exc}") from exc

        if not bool(payload.get("success")):
            raise HTTPException(status_code=502, detail=str(payload.get("error") or f"Creo bridge action '{action}' failed."))

        return payload.get("result")


bridge_state = CreoBridgeState()


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
    seen = set()
    unique = []
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
    if score < 0:
        return 0.0
    if score > 1:
        return 1.0
    return float(score)


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

    if best < 0:
        return 0.0
    if best > 1:
        return 1.0
    return float(best)


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


def load_synonym_examples() -> dict:
    global synonym_examples_by_class
    if synonym_examples_by_class is not None:
        return synonym_examples_by_class

    examples_map = {}
    seen_per_class = {}
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

    merged = []
    by_key = {}
    for item in suggestions:
        class_name = str(item.get("className") or "").strip()
        if class_name == "":
            continue
        key = class_name.lower()
        if key in by_key:
            continue

        confidence = float(item.get("confidence") or 0.0)
        confidence = max(0.0, min(1.0, confidence))
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
                "Install the required packages from local_ml_service/requirements.txt "
                "using a Python version supported by scikit-learn for this model artifact. "
                f"Missing module: {exc.name}"
            ),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Model artifact could not be loaded: {exc}",
        ) from exc


def model_runtime_ready() -> bool:
    return find_spec("sklearn") is not None


def _deindent_removed_if_content(
    out: List[str],
    marker_indexes: List[int],
    remove_marker_by_out_index: Dict[int, bool],
    upper_bound: int = None,
) -> None:
    first_mark = marker_indexes[0]
    last_mark = upper_bound if upper_bound is not None else marker_indexes[-1]
    for ci in range(first_mark + 1, last_mark):
        if remove_marker_by_out_index.get(ci):
            continue
        out[ci] = out[ci].lstrip()


def clean_proprogram_text_for_overwrite(file_text: str, add_postrelations_break: bool = True) -> str:
    raw = str(file_text or "")
    # Detect original line ending so we preserve it on output
    if "\r\n" in raw:
        eol = "\r\n"
    elif "\r" in raw:
        eol = "\r"
    else:
        eol = "\n"
    lines = re.split(r"\r\n|\n|\r", raw)
    out: List[str] = []
    input_depth = 0
    execute_depth = 0
    if_stack: List[Dict[str, Any]] = []
    remove_marker_by_out_index: Dict[int, bool] = {}

    for line in lines:
        trimmed = str(line or "").strip()

        if input_depth > 0:
            if re.match(r"^INPUT\b", trimmed, re.I):
                input_depth += 1
                out.append(line)
            elif re.match(r"^END\s*INPUT\b", trimmed, re.I):
                input_depth -= 1
                out.append(line)
            continue

        if execute_depth > 0:
            if re.match(r"^EXECUTE\b", trimmed, re.I):
                execute_depth += 1
            elif re.match(r"^END\s*EXECUTE\b", trimmed, re.I):
                execute_depth -= 1
            continue

        if re.match(r"^INPUT\b", trimmed, re.I):
            input_depth = 1
            out.append(line)
            continue

        if re.match(r"^EXECUTE\b", trimmed, re.I):
            for frame in if_stack:
                frame["hasExecute"] = True
            execute_depth = 1
            continue

        if re.match(r"^END\s*INPUT\b", trimmed, re.I):
            out.append(line)
            continue

        if re.match(r"^END\s*EXECUTE\b", trimmed, re.I):
            continue

        if re.match(r"^ADD\b", trimmed, re.I):
            is_add_feature = re.match(r"^ADD\s+FEATURE\b", trimmed, re.I) is not None
            for frame in if_stack:
                if is_add_feature:
                    frame["hasAddFeature"] = True
                else:
                    frame["hasAddNonFeature"] = True

        if re.match(r"^IF\b", trimmed, re.I):
            if_idx = len(out)
            out.append(line)
            if_stack.append(
                {
                    "markerIndexes": [if_idx],
                    "hasAddFeature": False,
                    "hasAddNonFeature": False,
                    "hasExecute": False,
                }
            )
            continue

        if re.match(r"^ELSE\s*IF\b", trimmed, re.I) or re.match(r"^ELSE\b", trimmed, re.I):
            else_idx = len(out)
            out.append(line)
            if if_stack:
                if_stack[-1]["markerIndexes"].append(else_idx)
            continue

        if re.match(r"^END\s*IF\b", trimmed, re.I) or re.match(r"^ENDIF\b", trimmed, re.I):
            end_if_idx = len(out)
            out.append(line)
            if if_stack:
                frame = if_stack.pop()
                frame["markerIndexes"].append(end_if_idx)
                if frame["hasExecute"] or frame["hasAddNonFeature"]:
                    for marker_index in frame["markerIndexes"]:
                        remove_marker_by_out_index[marker_index] = True
                    _deindent_removed_if_content(out, frame["markerIndexes"], remove_marker_by_out_index)
            continue

        out.append(line)

    while if_stack:
        frame = if_stack.pop()
        if frame["hasExecute"] or frame["hasAddNonFeature"]:
            for marker_index in frame["markerIndexes"]:
                remove_marker_by_out_index[marker_index] = True
            _deindent_removed_if_content(out, frame["markerIndexes"], remove_marker_by_out_index, upper_bound=len(out))

    final_out = [line for idx, line in enumerate(out) if not remove_marker_by_out_index.get(idx)]

    # Strip leading whitespace from ADD PART / ADD SUBASSEMBLY blocks
    in_component_block = False
    for p in range(len(final_out)):
        p_trimmed = final_out[p].strip()
        if re.match(r"^ADD\s+(PART|SUBASSEMBLY)\b", p_trimmed, re.I):
            in_component_block = True
        if in_component_block:
            final_out[p] = final_out[p].lstrip()
        if re.match(r"^END\s+ADD\b", p_trimmed, re.I) and in_component_block:
            in_component_block = False

    # Collapse consecutive blank lines, but ensure blank line before section keywords
    collapsed: List[str] = []
    # Collapse consecutive blank lines
    collapsed: List[str] = []
    last_was_blank = False
    lines_for_collapse = final_out
    for i, line in enumerate(lines_for_collapse):
        is_blank = line.strip() == ""
        if is_blank and last_was_blank:
            continue
        # Ensure blank line before POSTRELATIONS (when toggle is on)
        if add_postrelations_break and not is_blank and not last_was_blank and collapsed and re.match(r"^POSTRELATIONS\b", line.strip(), re.I):
            collapsed.append("")
        collapsed.append(line)
        last_was_blank = is_blank

    return eol.join(collapsed)


def iter_program_txt_files(directory_path: str) -> List[Path]:
    root = Path(directory_path)
    if not root.exists() or not root.is_dir():
        raise HTTPException(status_code=400, detail=f"Folder not found: {directory_path}")

    matches: List[Path] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if re.search(r"\.(txt|als)(\.\d+)?$", path.name, re.I):
            matches.append(path)
    return matches


def get_file_name_from_path(path_text: str) -> str:
    return Path(str(path_text or "")).name


def parse_owner_from_program(lines: List[str]) -> Dict[str, str]:
    line3 = str(lines[2] if len(lines) >= 3 else "")
    match = re.search(r"LISTING\s+FOR\s+([A-Z_]+)\s+([A-Z0-9_.-]+)", line3, flags=re.IGNORECASE)
    if match:
        return {
            "ownerType": str(match.group(1) or "").upper(),
            "ownerModel": str(match.group(2) or ""),
        }

    for line in lines:
        match = re.search(r"LISTING\s+FOR\s+([A-Z_]+)\s+([A-Z0-9_.-]+)", str(line or ""), flags=re.IGNORECASE)
        if match:
            return {
                "ownerType": str(match.group(1) or "").upper(),
                "ownerModel": str(match.group(2) or ""),
            }

    return {"ownerType": "", "ownerModel": ""}


def current_if_condition(cond_stack: List[str]) -> str:
    if not cond_stack:
        return ""
    return " && ".join(cond_stack)


def parse_proprogram_for_ebom(file_text: str, file_path: str) -> Dict[str, Any]:
    lines = re.split(r"\r\n|\n|\r", str(file_text or ""))
    owner = parse_owner_from_program(lines)
    hierarchy_rows: List[Dict[str, str]] = []
    inheritance_rows: List[Dict[str, str]] = []
    cond_stack: List[str] = []

    index = 0
    while index < len(lines):
        line = str(lines[index] or "").strip()
        if line == "":
            index += 1
            continue

        if_match = re.match(r"^IF\s+(.+)$", line, flags=re.IGNORECASE)
        if if_match:
            cond_stack.append(str(if_match.group(1) or "").strip())
            index += 1
            continue

        else_if_match = re.match(r"^ELSE\s*IF\s+(.+)$", line, flags=re.IGNORECASE)
        if else_if_match:
            if cond_stack:
                cond_stack.pop()
            cond_stack.append(f"NOT({str(else_if_match.group(1) or '').strip()})")
            index += 1
            continue

        if re.match(r"^ELSE\b", line, flags=re.IGNORECASE):
            if cond_stack:
                prev = str(cond_stack.pop() or "")
                cond_stack.append(f"NOT({prev})")
            index += 1
            continue

        if re.match(r"^END\s*IF\b", line, flags=re.IGNORECASE) or re.match(r"^ENDIF\b", line, flags=re.IGNORECASE):
            if cond_stack:
                cond_stack.pop()
            index += 1
            continue

        add_match = re.match(r"^ADD\s+(SUPPRESSED\s+)?(PART_SKELETON|PART|ASSEMBLY|SUBASSEMBLY)\s+([A-Z0-9_.-]+)", line, flags=re.IGNORECASE)
        if add_match:
            add_prefix = str(add_match.group(1) or "").strip().upper()
            add_type = str(add_match.group(2) or "").upper()
            child_type = add_type if add_prefix == "" else f"{add_prefix} {add_type}"
            child_model = str(add_match.group(3) or "")
            comp_id = ""
            end_add_idx = index

            for inner_idx in range(index + 1, len(lines)):
                block_line = str(lines[inner_idx] or "").strip()
                id_match = re.match(r"^INTERNAL\s+COMPONENT\s+ID\s+([0-9]+)", block_line, flags=re.IGNORECASE)
                if id_match:
                    comp_id = str(id_match.group(1) or "")
                if re.match(r"^END\s+ADD\b", block_line, flags=re.IGNORECASE):
                    end_add_idx = inner_idx
                    break

            hierarchy_rows.append(
                {
                    "ParentType": owner["ownerType"],
                    "ParentModel": owner["ownerModel"],
                    "ChildType": child_type,
                    "ChildModel": child_model,
                    "InternalComponentId": comp_id,
                    "Condition": current_if_condition(cond_stack),
                    "SourceName": get_file_name_from_path(file_path),
                    "SourceFile": file_path,
                }
            )
            index = end_add_idx + 1
            continue

        exec_match = re.match(r"^EXECUTE\s+(PART|ASSEMBLY|SUBASSEMBLY)\s+([A-Z0-9_.-]+)", line, flags=re.IGNORECASE)
        if exec_match:
            exec_type = str(exec_match.group(1) or "").upper()
            exec_model = str(exec_match.group(2) or "")
            end_exec_idx = index

            for inner_idx in range(index + 1, len(lines)):
                exec_line = str(lines[inner_idx] or "").strip()
                if re.match(r"^END\s*EXECUTE\b", exec_line, flags=re.IGNORECASE) or re.match(r"^ENDEXECUTE\b", exec_line, flags=re.IGNORECASE):
                    end_exec_idx = inner_idx
                    break

                map_match = re.match(r"^([A-Z0-9_.$-]+)\s*=\s*(.+)$", exec_line, flags=re.IGNORECASE)
                if map_match:
                    inheritance_rows.append(
                        {
                            "ParentModel": owner["ownerModel"],
                            "ChildType": exec_type,
                            "ChildModel": exec_model,
                            "ChildParam": str(map_match.group(1) or ""),
                            "ParentExpr": str(map_match.group(2) or "").strip(),
                            "Condition": current_if_condition(cond_stack),
                            "SourceName": get_file_name_from_path(file_path),
                            "SourceFile": file_path,
                        }
                    )

            index = end_exec_idx + 1
            continue

        index += 1

    return {
        "ownerType": owner["ownerType"],
        "ownerModel": owner["ownerModel"],
        "hierarchyRows": hierarchy_rows,
        "inheritanceRows": inheritance_rows,
    }


def normalize_text_for_key(value: Any) -> str:
    return str(value if value is not None else "").strip().upper()


def merge_source_columns(target: Dict[str, Any], source_name: str, source_file: str) -> None:
    target["SourceCount"] = int(target.get("SourceCount") or 0) + 1
    target.setdefault("SourceNames", "")
    target.setdefault("SourceFiles", "")

    if source_name:
        names = f";{target['SourceNames']};"
        if f";{source_name};" not in names:
            target["SourceNames"] = source_name if target["SourceNames"] == "" else f"{target['SourceNames']}; {source_name}"

    if source_file:
        files = f";{target['SourceFiles']};"
        if f";{source_file};" not in files:
            target["SourceFiles"] = source_file if target["SourceFiles"] == "" else f"{target['SourceFiles']}; {source_file}"


def dedupe_ebom_data(data: Dict[str, Any]) -> Dict[str, Any]:
    out = {"hierarchyAll": [], "inheritanceAll": [], "ownerRows": []}
    hierarchy_map: Dict[str, Dict[str, Any]] = {}
    inheritance_map: Dict[str, Dict[str, Any]] = {}
    owner_map: Dict[str, Dict[str, Any]] = {}

    for row in data.get("hierarchyAll", []):
        row_key = "|".join(
            [
                normalize_text_for_key(row.get("ParentType")),
                normalize_text_for_key(row.get("ParentModel")),
                normalize_text_for_key(row.get("ChildType")),
                normalize_text_for_key(row.get("ChildModel")),
                normalize_text_for_key(row.get("InternalComponentId")),
                normalize_text_for_key(row.get("Condition")),
            ]
        )
        if row_key not in hierarchy_map:
            hierarchy_map[row_key] = {
                "ParentType": row.get("ParentType", ""),
                "ParentModel": row.get("ParentModel", ""),
                "ChildType": row.get("ChildType", ""),
                "ChildModel": row.get("ChildModel", ""),
                "InternalComponentId": row.get("InternalComponentId", ""),
                "Condition": row.get("Condition", ""),
                "SourceCount": 0,
                "SourceNames": "",
                "SourceFiles": "",
            }
            out["hierarchyAll"].append(hierarchy_map[row_key])
        merge_source_columns(hierarchy_map[row_key], str(row.get("SourceName") or ""), str(row.get("SourceFile") or ""))

    for row in data.get("inheritanceAll", []):
        row_key = "|".join(
            [
                normalize_text_for_key(row.get("ParentModel")),
                normalize_text_for_key(row.get("ChildType")),
                normalize_text_for_key(row.get("ChildModel")),
                normalize_text_for_key(row.get("ChildParam")),
                normalize_text_for_key(row.get("ParentExpr")),
                normalize_text_for_key(row.get("Condition")),
            ]
        )
        if row_key not in inheritance_map:
            inheritance_map[row_key] = {
                "ParentModel": row.get("ParentModel", ""),
                "ChildType": row.get("ChildType", ""),
                "ChildModel": row.get("ChildModel", ""),
                "ChildParam": row.get("ChildParam", ""),
                "ParentExpr": row.get("ParentExpr", ""),
                "Condition": row.get("Condition", ""),
                "SourceCount": 0,
                "SourceNames": "",
                "SourceFiles": "",
            }
            out["inheritanceAll"].append(inheritance_map[row_key])
        merge_source_columns(inheritance_map[row_key], str(row.get("SourceName") or ""), str(row.get("SourceFile") or ""))

    for row in data.get("ownerRows", []):
        row_key = "|".join([normalize_text_for_key(row.get("OwnerType")), normalize_text_for_key(row.get("OwnerModel"))])
        if row_key not in owner_map:
            owner_map[row_key] = {
                "OwnerType": row.get("OwnerType", ""),
                "OwnerModel": row.get("OwnerModel", ""),
                "SourceCount": 0,
                "SourceNames": "",
                "SourceFiles": "",
            }
            out["ownerRows"].append(owner_map[row_key])
        merge_source_columns(owner_map[row_key], str(row.get("SourceName") or ""), str(row.get("SourceFile") or ""))

    return out


def parse_ebom_directory(directory_path: Optional[str]) -> Dict[str, Any]:
    target_path = Path(str(directory_path or "").strip() or str(DEFAULT_EBOM_SCAN_DIR))
    if not target_path.exists() or not target_path.is_dir():
        raise HTTPException(status_code=400, detail=f"Folder not found: {target_path}")

    files = iter_program_txt_files(str(target_path))
    if not files:
        return {
            "directoryPath": str(target_path),
            "parsedCount": 0,
            "hierarchyAll": [],
            "inheritanceAll": [],
            "ownerRows": [],
        }

    hierarchy_all: List[Dict[str, Any]] = []
    inheritance_all: List[Dict[str, Any]] = []
    owner_rows: List[Dict[str, Any]] = []
    parsed_count = 0

    for file_path in files:
        try:
            file_text = file_path.read_text(encoding="utf-8", errors="ignore")
            parsed = parse_proprogram_for_ebom(file_text, str(file_path))
            parsed_count += 1
            owner_rows.append(
                {
                    "OwnerType": parsed.get("ownerType", ""),
                    "OwnerModel": parsed.get("ownerModel", ""),
                    "SourceName": get_file_name_from_path(str(file_path)),
                    "SourceFile": str(file_path),
                }
            )
            hierarchy_all.extend(parsed.get("hierarchyRows", []))
            inheritance_all.extend(parsed.get("inheritanceRows", []))
        except Exception:
            continue

    result = dedupe_ebom_data(
        {
            "hierarchyAll": hierarchy_all,
            "inheritanceAll": inheritance_all,
            "ownerRows": owner_rows,
        }
    )
    result["directoryPath"] = str(target_path)
    result["parsedCount"] = parsed_count
    return result


def clean_program_directory(directory_path: str) -> Dict[str, Any]:
    files = iter_program_txt_files(directory_path)
    if not files:
        return {
            "directoryPath": directory_path,
            "files": 0,
            "updated": 0,
            "unchanged": 0,
            "failed": 0,
            "failedItems": [],
            "message": "No Pro/PROGRAM text files found in folder.",
        }

    updated = 0
    unchanged = 0
    failed = 0
    failed_items: List[str] = []

    for file_path in files:
        try:
            original = file_path.read_text(encoding="utf-8", errors="ignore")
            cleaned = clean_proprogram_text_for_overwrite(original)
            if cleaned == original:
                unchanged += 1
                continue
            file_path.write_text(cleaned, encoding="utf-8")
            updated += 1
        except Exception:
            failed += 1
            failed_items.append(file_path.name)

    message = (
        f"Clean complete. Files: {len(files)}, Updated: {updated}, "
        f"Unchanged: {unchanged}, Failed: {failed}."
    )
    if failed_items:
        message += " Failed files: " + ", ".join(failed_items[:10])

    return {
        "directoryPath": directory_path,
        "files": len(files),
        "updated": updated,
        "unchanged": unchanged,
        "failed": failed,
        "failedItems": failed_items,
        "message": message,
    }


def prepare_program_import_file(file_path: str) -> Dict[str, Any]:
    source_path = Path(str(file_path or "").strip())
    if not source_path.exists() or not source_path.is_file():
        raise HTTPException(status_code=400, detail=f"Import file not found: {source_path}")

    try:
        original = source_path.read_text(encoding="utf-8", errors="ignore")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read import file: {source_path}") from exc

    cleaned = clean_proprogram_text_for_overwrite(original)
    if cleaned == original:
        return {
            "filePath": str(source_path),
            "preparedPath": str(source_path),
            "cleaned": False,
            "temporary": False,
        }

    temp_name = f"{source_path.stem}.bridge_import_{uuid4().hex[:8]}{source_path.suffix}"
    temp_path = source_path.with_name(temp_name)
    try:
        temp_path.write_text(cleaned, encoding="utf-8")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not write cleaned import file: {temp_path}") from exc

    return {
        "filePath": str(source_path),
        "preparedPath": str(temp_path),
        "cleaned": True,
        "temporary": True,
    }


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

    suggestions = []
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


def local_control_panel_payload(request: Request) -> Dict[str, Any]:
    base_url = str(request.base_url).rstrip("/")
    return {
        "allowedOrigin": ALLOWED_ORIGIN,
        "configuredPort": int(str(LOCAL_PORT or ENV_DEFAULTS["LOCAL_PORT"])),
        "currentBaseUrl": base_url,
        "currentPort": request.url.port or int(str(LOCAL_PORT or ENV_DEFAULTS["LOCAL_PORT"])),
        "bridgeConnected": bridge_state.websocket is not None,
        "bridgeClient": bridge_state.client_name,
        "modelRuntimeReady": model_runtime_ready(),
        "bridgeUrl": f"{base_url}/creo_bridge.html",
        "workbenchUrl": f"{base_url}/index.html",
        "restartRequired": False,
    }


@app.get("/")
def local_control_panel_ui() -> FileResponse:
    return FileResponse(STATIC_DIR / "local_control_panel.html")


@app.get("/workbench", response_class=RedirectResponse, status_code=307)
def browser_ui() -> str:
    return "/index.html"


@app.get("/index.html")
def legacy_index_ui() -> FileResponse:
    return FileResponse(WORKSPACE_DIR / "index.html")


@app.get("/bulkEditView.html")
def legacy_bulk_edit_ui() -> FileResponse:
    return FileResponse(WORKSPACE_DIR / "bulkEditView.html")


@app.get("/programVisualizerView.html")
def legacy_program_visualizer_ui() -> FileResponse:
    return FileResponse(WORKSPACE_DIR / "programVisualizerView.html")


@app.get("/featureRulesView.html")
def legacy_feature_rules_ui() -> FileResponse:
    return FileResponse(WORKSPACE_DIR / "featureRulesView.html")


@app.get("/featureRulesFinalBomView.html")
def legacy_feature_rules_final_bom_ui() -> FileResponse:
    return FileResponse(WORKSPACE_DIR / "featureRulesFinalBomView.html")


@app.get("/Class.csv")
def class_catalog_csv() -> FileResponse:
    return FileResponse(WORKSPACE_DIR / "Class.csv")


@app.get("/local_ml_service/training_data_template.csv")
def training_template_csv() -> FileResponse:
    return FileResponse(TRAINING_DATA_PATH)


@app.get("/creo_bridge.html")
def bridge_ui() -> FileResponse:
    return FileResponse(STATIC_DIR / "creo_bridge.html")


@app.get("/api/local/status")
def local_status(request: Request) -> Dict[str, Any]:
    return local_control_panel_payload(request)


@app.get("/api/local/config")
def local_config(request: Request) -> Dict[str, Any]:
    return local_control_panel_payload(request)


@app.post("/api/local/config")
def update_local_config(body: LocalConfigUpdateRequest, request: Request) -> Dict[str, Any]:
    global ALLOWED_ORIGIN, LOCAL_PORT

    values = parse_env_file()
    values["API_KEY"] = values.get("API_KEY") or API_KEY or secrets.token_urlsafe(32)
    values["ALLOWED_ORIGIN"] = str(body.allowedOrigin or "").strip()
    values["LOCAL_PORT"] = str(int(body.localPort))
    write_env_file(values)

    ALLOWED_ORIGIN = values["ALLOWED_ORIGIN"]
    LOCAL_PORT = values["LOCAL_PORT"]

    payload = local_control_panel_payload(request)
    payload["allowedOrigin"] = ALLOWED_ORIGIN
    payload["configuredPort"] = int(LOCAL_PORT)
    payload["restartRequired"] = True
    return payload


@app.get("/health")
def health(request: Request) -> Dict[str, Any]:
    base_url = str(request.base_url).rstrip("/")
    return {
        "status": "ok",
        "modelLoaded": MODEL_PATH.exists(),
        "modelRuntimeReady": model_runtime_ready(),
        "modelPath": str(MODEL_PATH),
        "bridgeConnected": bridge_state.websocket is not None,
        "uiUrl": f"{base_url}/",
        "bridgeUrl": f"{base_url}/creo_bridge.html",
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


@app.get("/api/bridge/status")
def bridge_status() -> Dict[str, Any]:
    return bridge_state.status_payload()


@app.get("/api/classes")
def list_catalog_classes() -> Dict[str, Any]:
    return {"classes": get_catalog_classes_from_metadata(), "modelVersion": get_model_version()}


@app.get("/api/model/current")
async def get_current_model() -> Any:
    return await bridge_state.call("current_model", timeout=20.0)


@app.get("/api/bom")
async def get_bom() -> Any:
    return await bridge_state.call("bom_tree", timeout=180.0)


@app.get("/api/parameters/{model_name_ext:path}")
async def get_parameters(model_name_ext: str) -> Any:
    return await bridge_state.call("parameters_list", args={"modelNameExt": model_name_ext}, timeout=60.0)


@app.post("/api/parameters/set")
async def set_parameter(body: ParameterSetRequest) -> Any:
    return await bridge_state.call("parameter_set", args=body.model_dump(), timeout=30.0)


@app.post("/api/parameters/create")
async def create_parameter(body: ParameterCreateRequest) -> Any:
    return await bridge_state.call("parameter_create", args=body.model_dump(), timeout=30.0)


@app.post("/api/macro")
async def run_macro(body: MacroRequest) -> Any:
    return await bridge_state.call("macro_run", args=body.model_dump(), timeout=60.0)


@app.get("/api/directory/current")
async def get_current_directory() -> Any:
    return await bridge_state.call("directory_get", timeout=20.0)


@app.post("/api/directory/current")
async def set_current_directory(body: DirectoryRequest) -> Any:
    return await bridge_state.call("directory_set", args=body.model_dump(), timeout=20.0)


@app.post("/api/log/append")
async def append_gateway_log(body: LogAppendRequest) -> Any:
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    source = str(body.source or "ui").strip() or "ui"
    message = str(body.message or "").replace("\r\n", "\n").replace("\r", "\n")
    message = message.replace("\n", " | ").strip()
    line = f"[{timestamp}] [{source}] {message}\n"

    try:
        with GATEWAY_LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(line)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not write log file: {GATEWAY_LOG_PATH}") from exc

    return {"ok": True, "path": str(GATEWAY_LOG_PATH), "bytes": len(line)}


@app.post("/api/model/open")
async def open_model(body: ModelRequest) -> Any:
    return await bridge_state.call("model_open", args=body.model_dump(), timeout=30.0)


@app.post("/api/model/close")
async def close_model(body: ModelRequest) -> Any:
    return await bridge_state.call("model_close", args=body.model_dump(), timeout=30.0)


@app.post("/api/model/regenerate")
async def regenerate_model(body: ModelRequest) -> Any:
    return await bridge_state.call("model_regenerate", args=body.model_dump(), timeout=30.0)


@app.post("/api/model/save")
async def save_model(body: ModelRequest) -> Any:
    return await bridge_state.call("model_save", args=body.model_dump(), timeout=60.0)


@app.post("/api/classification/save")
async def save_classification(body: ClassificationSaveRequest) -> Any:
    return await bridge_state.call("classification_save", args=body.model_dump(), timeout=30.0)


@app.post("/api/macro/bom")
async def run_bom_macro(body: BomMacroRequest) -> Any:
    timeout_seconds = max(60.0, float(max(1, len(body.models))) * max(1.0, float(body.delayMs) / 1000.0 + 1.5))
    return await bridge_state.call("macro_run_for_models", args=body.model_dump(), timeout=timeout_seconds)


@app.post("/api/feature/resume")
async def resume_feature_by_id(body: FeatureByIdRequest) -> Any:
    return await bridge_state.call("feature_resume_by_id", args=body.model_dump(), timeout=60.0)


@app.post("/api/feature/suppress")
async def suppress_feature_by_id(body: FeatureByIdRequest) -> Any:
    return await bridge_state.call("feature_suppress_by_id", args=body.model_dump(), timeout=60.0)


@app.post("/api/program/export")
async def program_export(body: ProgramIoRequest) -> Any:
    return await bridge_state.call("program_export", args=body.model_dump(), timeout=60.0)


@app.post("/api/program/import")
async def program_import(body: ProgramIoRequest) -> Any:
    # Pass the original file path directly — Creo's model.Import() requires the file
    # to be named exactly {model_stem}.txt.  Any renaming (e.g. temp/cleaned copies)
    # breaks the import with a regen error.  No preprocessing is applied here.
    source_path = Path(str(body.filePath or "").strip())
    if not source_path.exists() or not source_path.is_file():
        raise HTTPException(status_code=400, detail=f"Import file not found: {source_path}")

    result = await bridge_state.call("program_import", args=body.model_dump(), timeout=300.0)
    return result


@app.post("/api/program/batch/export")
async def program_batch_export(body: ProgramBatchRequest) -> Any:
    timeout_seconds = max(60.0, float(max(1, len(body.models))) * 4.0)
    return await bridge_state.call("program_batch_export", args=body.model_dump(), timeout=timeout_seconds)


@app.post("/api/program/batch/import")
async def program_batch_import(body: ProgramBatchRequest) -> Any:
    timeout_seconds = max(120.0, float(max(1, len(body.models))) * 15.0)
    return await bridge_state.call("program_batch_import", args=body.model_dump(), timeout=timeout_seconds)


@app.post("/api/program/clean")
def program_clean(body: ProgramCleanRequest) -> Any:
    return clean_program_directory(body.directoryPath)


@app.post("/api/program/clean-file")
def program_clean_file(body: ProgramCleanFileRequest) -> Any:
    source_path = Path(str(body.filePath or "").strip())
    if not source_path.exists() or not source_path.is_file():
        raise HTTPException(status_code=400, detail=f"File not found: {source_path}")
    try:
        original = source_path.read_text(encoding="utf-8", errors="ignore")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read file: {source_path}") from exc

    cleaned = clean_proprogram_text_for_overwrite(original, add_postrelations_break=body.addPostrelationsBreak)
    changed = cleaned != original
    if changed:
        try:
            source_path.write_text(cleaned, encoding="utf-8")
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Could not write cleaned file: {source_path}") from exc

    return {"filePath": str(source_path), "cleaned": changed}


@app.post("/api/ebom/parse")
def ebom_parse(body: EbomParseRequest) -> Any:
    return parse_ebom_directory(body.directoryPath)


@app.websocket("/ws/creo")
async def creo_bridge_socket(websocket: WebSocket) -> None:
    await bridge_state.register(websocket)
    try:
        await websocket.send_json({"type": "server-ready", "service": "Creo Gateway", "version": app.version})
        while True:
            payload = await websocket.receive_json()
            message_type = str(payload.get("type") or "")
            if message_type == "bridge-ready":
                bridge_state.update_identity(payload)
                continue
            if message_type == "result":
                bridge_state.resolve(payload)
                continue
            if message_type == "ping":
                await websocket.send_json({"type": "pong", "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    except WebSocketDisconnect:
        pass
    finally:
        await bridge_state.unregister(websocket)


if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
if WORKSPACE_CSS_DIR.is_dir():
    app.mount("/css", StaticFiles(directory=str(WORKSPACE_CSS_DIR)), name="workspace-css")
if WORKSPACE_JS_DIR.is_dir():
    app.mount("/js", StaticFiles(directory=str(WORKSPACE_JS_DIR)), name="workspace-js")
    app.mount("/legacy-js", StaticFiles(directory=str(WORKSPACE_JS_DIR)), name="legacy-js")
