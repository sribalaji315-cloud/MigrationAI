from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, selectinload
from typing import Dict, List, Any, Optional
from ..db import models
from ..db.session import get_db
from ..schemas import StateIn
from ..core.security import get_current_user

router = APIRouter(tags=["state"])

@router.get("/health")
def health():
    return {"ok": True}

@router.get("/state")
def get_state(include_bom: bool = Query(True), db: Session = Depends(get_db)):
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
    if include_bom:
        db_items = db.query(models.BomItem).options(selectinload(models.BomItem.features)).all()
        bom_payload: List[Dict[str, Any]] = []
        for itm in db_items:
            features_payload: List[Dict[str, Any]] = []
            for feat in itm.features:
                raw_values: Any = getattr(feat, "values", []) or []

                # Support both the original representation (list of strings)
                # and a richer object with value descriptions stored in the JSON
                values: List[str]
                value_descriptions: Dict[str, str]

                if isinstance(raw_values, list):
                    values = [str(v) for v in raw_values]
                    value_descriptions = {}
                elif isinstance(raw_values, dict):
                    values_raw = raw_values.get("values") or []
                    values = [str(v) for v in values_raw]
                    vd = raw_values.get("valueDescriptions") or {}
                    # normalise keys to strings
                    value_descriptions = {
                        str(k): str(v)
                        for k, v in vd.items()
                        if k is not None
                    }
                else:
                    values = []
                    value_descriptions = {}

                features_payload.append(
                    {
                        "featureId": getattr(feat, "feature_id", None),
                        "description": getattr(feat, "description", ""),
                        **({"unit": getattr(feat, "unit", None)} if getattr(feat, "unit", None) else {}),
                        "values": values,
                        **({"valueDescriptions": value_descriptions} if value_descriptions else {}),
                    }
                )
            bom_payload.append(
                {
                    "itemId": getattr(itm, "item_id", None),
                    "description": getattr(itm, "description", ""),
                    **({"category": getattr(itm, "category", None)} if getattr(itm, "category", None) else {}),
                    **({"productType": getattr(itm, "product_type", None)} if getattr(itm, "product_type", None) else {}),
                    "features": features_payload,
                }
            )
        state["bom"] = bom_payload
    else:
        state["bom"] = []

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


@router.get("/bom/filters")
def get_bom_filters(
    category: Optional[str] = None,
    productType: Optional[str] = None,
    db: Session = Depends(get_db),
):
    base_query = db.query(models.BomItem)
    if category:
        base_query = base_query.filter(models.BomItem.category == category)
    if productType:
        base_query = base_query.filter(models.BomItem.product_type == productType)

    categories = (
        base_query.with_entities(models.BomItem.category)
        .distinct()
        .all()
    )
    product_types = (
        base_query.with_entities(models.BomItem.product_type)
        .distinct()
        .all()
    )

    category_list = sorted({c[0] for c in categories if c and c[0]})
    product_type_list = sorted({p[0] for p in product_types if p and p[0]})

    return {"categories": category_list, "productTypes": product_type_list}


def _build_bom_payload(db_items: List[models.BomItem]) -> List[Dict[str, Any]]:
    bom_payload: List[Dict[str, Any]] = []

    for itm in db_items:
        features_payload: List[Dict[str, Any]] = []
        for feat in itm.features:
            raw_values: Any = getattr(feat, "values", []) or []
            values: List[str]
            value_descriptions: Dict[str, str]

            if isinstance(raw_values, list):
                values = [str(v) for v in raw_values]
                value_descriptions = {}
            elif isinstance(raw_values, dict):
                values_raw = raw_values.get("values") or []
                values = [str(v) for v in values_raw]
                vd = raw_values.get("valueDescriptions") or {}
                value_descriptions = {
                    str(k): str(v)
                    for k, v in vd.items()
                    if k is not None
                }
            else:
                values = []
                value_descriptions = {}

            features_payload.append(
                {
                    "featureId": getattr(feat, "feature_id", None),
                    "description": getattr(feat, "description", ""),
                    **({"unit": getattr(feat, "unit", None)} if getattr(feat, "unit", None) else {}),
                    "values": values,
                    **({"valueDescriptions": value_descriptions} if value_descriptions else {}),
                }
            )

        bom_payload.append(
            {
                "itemId": getattr(itm, "item_id", None),
                "description": getattr(itm, "description", ""),
                **({"category": getattr(itm, "category", None)} if getattr(itm, "category", None) else {}),
                **({"productType": getattr(itm, "product_type", None)} if getattr(itm, "product_type", None) else {}),
                "features": features_payload,
            }
        )

    return bom_payload


@router.get("/bom/items")
def get_bom_items(
    category: Optional[str] = None,
    productType: Optional[str] = None,
    limit: int = Query(0, ge=0, le=5000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    query = db.query(models.BomItem).options(selectinload(models.BomItem.features))
    if category:
        query = query.filter(models.BomItem.category == category)
    if productType:
        query = query.filter(models.BomItem.product_type == productType)

    query = query.order_by(models.BomItem.item_id)
    if limit:
        query = query.limit(limit).offset(offset)

    db_items = query.all()
    return _build_bom_payload(db_items)


@router.post("/bom/items/by-ids")
def get_bom_items_by_ids(
    payload: List[str],
    db: Session = Depends(get_db),
):
    item_ids = [i for i in payload if i]
    if not item_ids:
        return []

    db_items = db.query(models.BomItem).options(selectinload(models.BomItem.features)).filter(models.BomItem.item_id.in_(item_ids)).all()
    return _build_bom_payload(db_items)

@router.post("/sync")
def sync_state(payload: StateIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    # when classifications are persisted separately we ignore that property on sync requests
    incoming = dict(payload.state)
    incoming.pop("classifications", None)

    # peel off BOM, mappings and localMappings so they are stored in dedicated tables
    # Only replace BOM when it is explicitly included in the payload (key present and non-null).
    # Workspace saves don't include the full BOM, so we must not wipe the table for those.
    bom_key_present = "bom" in incoming
    bom_payload = incoming.pop("bom", None)
    mappings_payload = incoming.pop("mappings", []) or []
    local_mappings_payload = incoming.pop("localMappings", {}) or {}

    # Replace BOM & features ONLY when the caller explicitly sent a bom list
    if bom_key_present and bom_payload is not None:
        db.query(models.BomFeature).delete()
        db.query(models.BomItem).delete()

        bom_items_to_add = []
        for item in (bom_payload or []):
            item_id = item.get("itemId")
            if not item_id:
                continue
            description = item.get("description") or ""
            db_item = models.BomItem(
                item_id=item_id,
                description=description,
                category=item.get("category") or None,
                product_type=item.get("productType") or None,
            )
            
            features_to_add = []
            for feat in item.get("features") or []:
                feature_id = feat.get("featureId")
                if not feature_id:
                    continue

                raw_values = feat.get("values") or []
                value_descriptions = feat.get("valueDescriptions") or {}

                # When value descriptions are provided, store an object in the JSON column
                # so we can round-trip both values and descriptions. Otherwise, keep the
                # original list-of-strings representation.
                if value_descriptions:
                    composite_values: Any = {
                        "values": raw_values,
                        "valueDescriptions": value_descriptions,
                    }
                else:
                    composite_values = raw_values

                db_feature = models.BomFeature(
                    feature_id=feature_id,
                    description=feat.get("description") or "",
                    unit=feat.get("unit") or None,
                    values=composite_values,
                )
                features_to_add.append(db_feature)
            
            db_item.features = features_to_add
            bom_items_to_add.append(db_item)
            
        if bom_items_to_add:
            db.add_all(bom_items_to_add)

    # Replace global mappings
    db.query(models.GlobalMapping).delete()
    global_mappings_to_add = []
    for m in mappings_payload:
        db_mapping = models.GlobalMapping(
            legacy_feature_ids=m.get("legacyFeatureIds") or [],
            new_attribute_id=m.get("newAttributeId") or "",
            value_mappings=m.get("valueMappings") or {},
        )
        global_mappings_to_add.append(db_mapping)
    if global_mappings_to_add:
        db.add_all(global_mappings_to_add)

    # Replace local attribute mappings
    db.query(models.LocalAttributeMapping).delete()

    item_ids = list((local_mappings_payload or {}).keys())
    bom_rows = db.query(models.BomItem).filter(models.BomItem.item_id.in_(item_ids)).all()
    bom_by_item_id = {row.item_id: row for row in bom_rows}

    local_mappings_to_add = []
    for item_id, mappings_for_item in (local_mappings_payload or {}).items():
        if not item_id:
            continue

        # Look up description from BOM table if present
        bom_row = bom_by_item_id.get(item_id)
        item_desc = getattr(bom_row, "description", "") if bom_row else ""
        item_category = getattr(bom_row, "category", None) if bom_row else None
        item_product_type = getattr(bom_row, "product_type", None) if bom_row else None

        for m in mappings_for_item or []:
            legacy_ids = m.get("legacyFeatureIds") or []
            new_attr = m.get("newAttributeId") or ""
            values_map = m.get("valueMappings") or {}

            for legacy_attr in legacy_ids:
                # If there are no per-value mappings, we still need to persist the
                # attribute-level override (e.g. NOT REQUIRED) so that it survives
                # a round-trip through the database. We do this by inserting a
                # sentinel row with an empty legacy_value / new_value pair.
                if not values_map:
                    row = models.LocalAttributeMapping(
                        item_id=item_id,
                        item_description=item_desc,
                        category=item_category,
                        product_type=item_product_type,
                        legacy_attribute_id=legacy_attr,
                        legacy_value="",
                        new_attribute_id=new_attr,
                        new_value="",
                    )
                    local_mappings_to_add.append(row)
                    continue

                for legacy_val, new_val in values_map.items():
                    if legacy_attr and legacy_val is not None:
                        row = models.LocalAttributeMapping(
                            item_id=item_id,
                            item_description=item_desc,
                            category=item_category,
                            product_type=item_product_type,
                            legacy_attribute_id=legacy_attr,
                            legacy_value=str(legacy_val),
                            new_attribute_id=new_attr,
                            new_value=str(new_val),
                        )
                        local_mappings_to_add.append(row)
    
    if local_mappings_to_add:
        db.add_all(local_mappings_to_add)

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

    response_payload: Dict[str, Any] = {"ok": True}

    if action == "acquire":
        userId = action_payload.get("userId")
        userName = action_payload.get("userName")
        existing = locks.get(itemId)
        if existing and existing.get("userId") != userId:
            # Another user holds this lock
            return {"acquired": False, "reason": "locked"}
        if not existing:
            user_lock_count = sum(1 for l in locks.values() if l.get("userId") == userId)
            if user_lock_count >= 2:
                return {"acquired": False, "reason": "limit"}
        locks[itemId] = {
            "itemId": itemId,
            "userId": userId,
            "userName": userName,
            "timestamp": __import__("time").time() * 1000,
        }
        response_payload = {"acquired": True}
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
    return response_payload

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
