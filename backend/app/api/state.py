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

    # --- Override BOM from dedicated tables --------------------------------------
    db_items = db.query(models.BomItem).all()
    bom_payload: List[Dict] = []
    for itm in db_items:
        features_payload: List[Dict] = []
        for feat in itm.features:
            features_payload.append(
                {
                    "featureId": getattr(feat, "feature_id", None),
                    "description": getattr(feat, "description", ""),
                    "values": getattr(feat, "values", []) or [],
                }
            )
        bom_payload.append(
            {
                "itemId": getattr(itm, "item_id", None),
                "description": getattr(itm, "description", ""),
                "features": features_payload,
            }
        )
    state["bom"] = bom_payload

    # --- Override global mappings from dedicated table ---------------------------
    db_mappings = db.query(models.GlobalMapping).all()
    mappings_payload: List[Dict] = []
    for m in db_mappings:
        mappings_payload.append(
            {
                "legacyFeatureIds": getattr(m, "legacy_feature_ids", []) or [],
                "newAttributeId": getattr(m, "new_attribute_id", ""),
                "valueMappings": getattr(m, "value_mappings", {}) or {},
            }
        )
    state["mappings"] = mappings_payload

    # --- Override local item-level mappings from dedicated table -----------------
    db_locals = db.query(models.LocalAttributeMapping).all()
    local_by_item: Dict[str, Dict[tuple, Dict]] = {}

    for row in db_locals:
        item_id = getattr(row, "item_id", None)
        legacy_attr = getattr(row, "legacy_attribute_id", None)
        new_attr = getattr(row, "new_attribute_id", None)
        legacy_val = getattr(row, "legacy_value", None)
        new_val = getattr(row, "new_value", None)
        if not item_id or not legacy_attr or not new_attr or legacy_val is None:
            continue

        bucket = local_by_item.setdefault(item_id, {})
        key = (legacy_attr, new_attr)
        mapping_obj = bucket.get(key)
        if not mapping_obj:
            mapping_obj = {
                "legacyFeatureIds": [legacy_attr],
                "newAttributeId": new_attr,
                "valueMappings": {},
            }
            bucket[key] = mapping_obj

        mapping_obj["valueMappings"][legacy_val] = new_val

    local_payload: Dict[str, List[Dict]] = {}
    for item_id, grouped in local_by_item.items():
        local_payload[item_id] = list(grouped.values())

    state["localMappings"] = local_payload

    return state

@router.post("/sync")
def sync_state(payload: StateIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # when classifications are persisted separately we ignore that property on sync requests
    incoming = dict(payload.state)
    incoming.pop("classifications", None)

    # peel off BOM, mappings and localMappings so they are stored in dedicated tables
    bom_payload = incoming.pop("bom", []) or []
    mappings_payload = incoming.pop("mappings", []) or []
    local_mappings_payload = incoming.pop("localMappings", {}) or {}

    # Replace BOM & features with the incoming state
    db.query(models.BomFeature).delete()
    db.query(models.BomItem).delete()

    for item in bom_payload:
        item_id = item.get("itemId")
        if not item_id:
            continue
        description = item.get("description") or ""
        db_item = models.BomItem(item_id=item_id, description=description)
        db.add(db_item)
        db.flush()  # obtain primary key for relationship

        for feat in item.get("features") or []:
            feature_id = feat.get("featureId")
            if not feature_id:
                continue
            db_feature = models.BomFeature(
                item_id=db_item.id,
                feature_id=feature_id,
                description=feat.get("description") or "",
                values=feat.get("values") or [],
            )
            db.add(db_feature)

    # Replace global mappings
    db.query(models.GlobalMapping).delete()
    for m in mappings_payload:
        db_mapping = models.GlobalMapping(
            legacy_feature_ids=m.get("legacyFeatureIds") or [],
            new_attribute_id=m.get("newAttributeId") or "",
            value_mappings=m.get("valueMappings") or {},
        )
        db.add(db_mapping)

    # Replace local attribute mappings
    db.query(models.LocalAttributeMapping).delete()

    for item_id, mappings_for_item in (local_mappings_payload or {}).items():
        if not item_id:
            continue

        # Look up description from BOM table if present
        bom_row = db.query(models.BomItem).filter(models.BomItem.item_id == item_id).first()
        item_desc = getattr(bom_row, "description", "") if bom_row else ""

        for m in mappings_for_item or []:
            legacy_ids = m.get("legacyFeatureIds") or []
            new_attr = m.get("newAttributeId") or ""
            values_map = m.get("valueMappings") or {}

            for legacy_attr in legacy_ids:
                for legacy_val, new_val in values_map.items():
                    if legacy_attr and legacy_val is not None:
                        row = models.LocalAttributeMapping(
                            item_id=item_id,
                            item_description=item_desc,
                            legacy_attribute_id=legacy_attr,
                            legacy_value=str(legacy_val),
                            new_attribute_id=new_attr,
                            new_value=str(new_val),
                        )
                        db.add(row)

    # Persist the remainder of the JSON state as a lightweight shell
    record = db.query(models.AppState).filter(models.AppState.id == 1).first()
    if not record:
        record = models.AppState(id=1, state=incoming)
        db.add(record)
    else:
        record.state = incoming

    db.commit()
    return {"ok": True}

@router.post("/lock")
def handle_lock(action_payload: Dict, db: Session = Depends(get_db)):
    """Acquire or release an item-level edit lock.

    The state JSON column is treated immutably here (copied and reassigned)
    so that SQLAlchemy reliably detects changes to the JSON structure.
    
    Note: Auth is not required for this endpoint to allow users to release their own locks
    even if there are auth issues. The userId in the payload is still validated.
    """
    print(f"[LOCK] Received action_payload: {action_payload}")
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
        print(f"[LOCK RELEASE] Attempting to release itemId={itemId}, userId={userId}, current locks: {locks}")
        if locks.get(itemId) and locks[itemId].get("userId") == userId:
            locks.pop(itemId, None)
            print(f"[LOCK RELEASE] Successfully released lock, remaining locks: {locks}")
        else:
            print(f"[LOCK RELEASE] Failed to release - condition not met. Lock exists: {locks.get(itemId) is not None}, UserId match: {locks.get(itemId) and locks[itemId].get('userId') == userId if locks.get(itemId) else False}")
    elif action == "force-release":
        # Force release without auth check for now (for debugging)
        # In production, this should check admin role
        locks.pop(itemId, None)
        print(f"[LOCK FORCE-RELEASE] Force released itemId={itemId}, remaining locks: {locks}")
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

    # also nuke any classifications, BOM, mappings and local overrides so
    # reset truly returns to defaults
    db.query(models.Classification).delete()
    db.query(models.BomFeature).delete()
    db.query(models.BomItem).delete()
    db.query(models.GlobalMapping).delete()
    db.query(models.LocalAttributeMapping).delete()
    db.commit()
    return {"ok": True}
