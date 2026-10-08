"""Tests for the batched BOM hierarchy walk and per-item mapping status detail.

Runs standalone (``python tests/test_bom_hierarchy_status.py``) and under pytest.
"""

import sys
import time
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api import state
from app.db import models
from app.db.session import Base


def _session(db_path: Path):
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)()


def _user():
    return models.User(id=1, username="tester", role="admin")


def _node(parent, item_id, level, description=""):
    return models.BomHierarchy(
        parent_bom=parent,
        item_id=item_id,
        level=level,
        description=description,
        qty=1,
        unit="ST0",
    )


def _mapping(item, feature, legacy_value, attr, new_value, attribute_type="engineering"):
    return models.WorkspaceMapping(
        legacy_item_id=item,
        legacy_feature_id=feature,
        legacy_value=legacy_value,
        new_attribute_id=attr,
        new_value=new_value,
        attribute_type=attribute_type,
        mapped_from="global",
        updated_at=time.time(),
    )


# --- batched children -------------------------------------------------------

def test_children_batch_returns_rows_for_all_parents(tmp_path: Path):
    db = _session(tmp_path / "bh1.db")
    try:
        db.add_all([
            _node("ROOT", "A-1", 1),
            _node("ROOT", "A-2", 1),
            _node("A-1", "B-1", 2),
            _node("A-2", "B-2", 2),
            _node("OTHER", "C-1", 1),
        ])
        db.commit()

        batch = state.get_bom_hierarchy_children_batch(
            payload={"parentIds": ["A-1", "A-2"]}, db=db, current_user=_user()
        )
        assert batch["total"] == 2
        assert {r["itemId"] for r in batch["items"]} == {"B-1", "B-2"}
        # parentBom is returned so the caller can regroup a multi-parent response.
        assert {r["parentBom"] for r in batch["items"]} == {"A-1", "A-2"}

        # Same rows as the single-parent endpoint.
        single = state.get_bom_hierarchy_children(parent_id="A-1", db=db, current_user=_user())
        assert single["items"][0]["itemId"] == "B-1"
    finally:
        db.close()


def test_children_batch_handles_blank_and_duplicate_ids(tmp_path: Path):
    db = _session(tmp_path / "bh2.db")
    try:
        db.add_all([_node("ROOT", "A-1", 1)])
        db.commit()

        empty = state.get_bom_hierarchy_children_batch(
            payload={"parentIds": ["", "   "]}, db=db, current_user=_user()
        )
        assert empty == {"items": [], "total": 0}

        deduped = state.get_bom_hierarchy_children_batch(
            payload={"parentIds": ["ROOT", "ROOT", " ROOT "]}, db=db, current_user=_user()
        )
        assert deduped["total"] == 1
    finally:
        db.close()


def test_children_batch_rejects_oversized_request(tmp_path: Path):
    db = _session(tmp_path / "bh3.db")
    try:
        too_many = [f"P-{i}" for i in range(state.MAX_HIERARCHY_BATCH_PARENTS + 1)]
        with pytest.raises(HTTPException) as exc:
            state.get_bom_hierarchy_children_batch(
                payload={"parentIds": too_many}, db=db, current_user=_user()
            )
        assert exc.value.status_code == 400
    finally:
        db.close()


# --- mapping status detail --------------------------------------------------

def _seed_mappings(db):
    db.add_all([
        # ITEM-1: one fully mapped feature, one feature with a blank target value.
        _mapping("ITEM-1", "ACOL", "RED", "ColorOfFabric", "Scarlet"),
        _mapping("ITEM-1", "ASIZE", "BIG", "Width", ""),
        # ITEM-2: fully mapped.
        _mapping("ITEM-2", "ACOL", "RED", "ColorOfFabric", "Scarlet"),
        # ITEM-3: nothing mapped at all.
        _mapping("ITEM-3", "ACOL", "RED", "UNMAPPED", ""),
        # ITEM-4: explicitly not required.
        _mapping("ITEM-4", "ATRIM", "GOLD", "NOT REQUIRED", "NOT REQUIRED"),
    ])
    db.commit()


def test_status_detail_buckets_and_counts(tmp_path: Path):
    db = _session(tmp_path / "st1.db")
    try:
        _seed_mappings(db)
        result = state.get_item_statuses_detail(
            payload={"itemIds": ["ITEM-1", "ITEM-2", "ITEM-3", "ITEM-4", "ITEM-MISSING"],
                     "attributeTypes": ["engineering"]},
            db=db,
            current_user=_user(),
        )["statuses"]

        assert result["ITEM-1"] == {"status": "partial", "mapped": 1, "notRequired": 0, "total": 2}
        assert result["ITEM-2"] == {"status": "mapped", "mapped": 1, "notRequired": 0, "total": 1}
        assert result["ITEM-3"] == {"status": "unmapped", "mapped": 0, "notRequired": 0, "total": 1}
        assert result["ITEM-4"] == {"status": "notRequired", "mapped": 0, "notRequired": 1, "total": 1}
        # An item with no workspace rows has nothing of this type to map.
        assert result["ITEM-MISSING"]["status"] == "notRequired"
        assert result["ITEM-MISSING"]["total"] == 0
    finally:
        db.close()


def test_status_detail_respects_attribute_types(tmp_path: Path):
    db = _session(tmp_path / "st2.db")
    try:
        db.add_all([
            _mapping("ITEM-1", "ACOL", "RED", "ColorOfFabric", "Scarlet"),
            _mapping("ITEM-1", "ABLURB", "TEXT", "UNMAPPED", "", attribute_type="marketing"),
        ])
        db.commit()

        engineering = state.get_item_statuses_detail(
            payload={"itemIds": ["ITEM-1"], "attributeTypes": ["engineering"]},
            db=db, current_user=_user(),
        )["statuses"]["ITEM-1"]
        assert engineering == {"status": "mapped", "mapped": 1, "notRequired": 0, "total": 1}

        both = state.get_item_statuses_detail(
            payload={"itemIds": ["ITEM-1"], "attributeTypes": ["engineering", "marketing"]},
            db=db, current_user=_user(),
        )["statuses"]["ITEM-1"]
        assert both == {"status": "partial", "mapped": 1, "notRequired": 0, "total": 2}
    finally:
        db.close()


def test_status_detail_falls_back_to_configured_included_types(tmp_path: Path):
    db = _session(tmp_path / "st3.db")
    try:
        db.add(models.AppConfig(
            id=1,
            mapping_type_config={"availableTypes": ["engineering", "marketing"], "includedTypes": ["engineering"]},
        ))
        db.add_all([
            _mapping("ITEM-1", "ACOL", "RED", "ColorOfFabric", "Scarlet"),
            _mapping("ITEM-1", "ABLURB", "TEXT", "UNMAPPED", "", attribute_type="marketing"),
        ])
        db.commit()

        result = state.get_item_statuses_detail(
            payload={"itemIds": ["ITEM-1"]}, db=db, current_user=_user(),
        )["statuses"]["ITEM-1"]
        assert result == {"status": "mapped", "mapped": 1, "notRequired": 0, "total": 1}
    finally:
        db.close()


def test_status_detail_rejects_bad_payloads(tmp_path: Path):
    db = _session(tmp_path / "st4.db")
    try:
        assert state.get_item_statuses_detail(
            payload={"itemIds": []}, db=db, current_user=_user()
        ) == {"statuses": {}}

        with pytest.raises(HTTPException):
            state.get_item_statuses_detail(
                payload={"itemIds": "ITEM-1"}, db=db, current_user=_user()
            )

        with pytest.raises(HTTPException):
            state.get_item_statuses_detail(
                payload={"itemIds": [f"I-{i}" for i in range(state.MAX_STATUS_DETAIL_ITEMS + 1)]},
                db=db, current_user=_user(),
            )
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
