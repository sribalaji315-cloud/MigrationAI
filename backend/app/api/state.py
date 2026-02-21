from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import Dict, List
from ..db import models
from ..db.session import get_db
from ..schemas import StateIn
from ..core.security import get_current_user

router = APIRouter(tags=["state"])

@router.get("/health")
def health():
    return {"ok": True}

@router.get("/state")
def get_state(db: Session = Depends(get_db)):
    record = db.query(models.AppState).filter(models.AppState.id == 1).first()
    # build base state from JSON store (omitting whatever classification list may accidentally be there)
    if not record or not record.state:
        state = {"bom": [], "mappings": [], "classifications": [], "localMappings": {}, "itemClassifications": {}, "locks": {}, "users": []}
    else:
        # copy so we can override classifications
        state = dict(record.state)
        # ensure keys exist
        for key in ["bom", "mappings", "localMappings", "itemClassifications", "locks", "users"]:
            if key not in state:
                state[key] = [] if key in ["bom", "mappings", "users"] else {}
        # drop any classifications that might reside here; they are now kept in a dedicated table
        state["classifications"] = []

    # override/merge classification list from classification table
    db_classes = db.query(models.Classification).all()
    state["classifications"] = [
        {"classId": c.class_id, "className": c.class_name, "attributes": c.attributes or []}
        for c in db_classes
    ]

    # also surface auth users from the users table in the shared state so the
    # User Identity Registry can see all accounts, not just those stored in
    # the AppState JSON. Existing JSON users are kept, and DB users are
    # merged in if they are missing.
    json_users: List[Dict] = state.get("users") or []
    # index existing JSON users by username for quick lookup
    existing_by_name = {u.get("userName"): u for u in json_users if isinstance(u, dict)}

    db_users = db.query(models.User).all()
    for u in db_users:
        if u.username not in existing_by_name:
            json_users.append({
                "userId": f"USR-{u.id}",
                "userName": u.username,
                # we never expose the real password hash to the UI; this
                # placeholder simply keeps the shape compatible
                "password": "",
                "role": u.role or "user",
            })

    state["users"] = json_users
    return state

@router.post("/sync")
def sync_state(payload: StateIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # when classifications are persisted separately we ignore that property on sync requests
    incoming = dict(payload.state)
    incoming.pop("classifications", None)

    record = db.query(models.AppState).filter(models.AppState.id == 1).first()
    if not record:
        record = models.AppState(id=1, state=incoming)
        db.add(record)
    else:
        record.state = incoming
    db.commit()
    return {"ok": True}

@router.post("/lock")
def handle_lock(action_payload: Dict, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Acquire or release an item-level edit lock.

    The state JSON column is treated immutably here (copied and reassigned)
    so that SQLAlchemy reliably detects changes to the JSON structure.
    """
    # Expected payload: { itemId, userId?, userName?, action }
    action = action_payload.get("action")
    itemId = action_payload.get("itemId")
    if not itemId or not action:
        raise HTTPException(status_code=400, detail="itemId and action required")

    record = db.query(models.AppState).filter(models.AppState.id == 1).first()

    # Start from existing state if present, otherwise an empty shell
    base_state: Dict = dict(record.state) if record and record.state else {}

    # Ensure a locks map exists and work on a shallow copy so that
    # we always assign a new object back into state.
    existing_locks = base_state.get("locks") or {}
    locks: Dict = dict(existing_locks)

    if action == "acquire":
        userId = action_payload.get("userId")
        userName = action_payload.get("userName")
        existing = locks.get(itemId)
        if existing and existing.get("userId") != userId:
            # Another user holds this lock
            return {"acquired": False}
        locks[itemId] = {
            "itemId": itemId,
            "userId": userId,
            "userName": userName,
            "timestamp": __import__("time").time() * 1000,
        }
    elif action == "release":
        userId = action_payload.get("userId")
        if locks.get(itemId) and locks[itemId].get("userId") == userId:
            locks.pop(itemId, None)
    elif action == "force-release":
        # only admins may force-release locks
        if getattr(current_user, "role", "user") != "admin":
            raise HTTPException(status_code=403, detail="admin role required to force-release locks")
        locks.pop(itemId, None)
    else:
        raise HTTPException(status_code=400, detail="unknown action")

    # Rebuild state with the updated locks map to guarantee SQLAlchemy
    # sees a new JSON structure.
    base_state["locks"] = locks

    if not record:
        record = models.AppState(id=1, state=base_state)
        db.add(record)
    else:
        record.state = base_state

    db.commit()
    return {"ok": True}

@router.post("/reset")
def reset(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # only admins may reset the application state
    if getattr(current_user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail="admin role required to reset state")
    record = db.query(models.AppState).filter(models.AppState.id == 1).first()
    if record:
        db.delete(record)
    # also nuke any classifications so reset truly returns to defaults
    db.query(models.Classification).delete()
    db.commit()
    return {"ok": True}
