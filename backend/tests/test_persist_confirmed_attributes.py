"""Tests for persisting the UI-displayed target attribute on approval.

Covers ``state._persist_confirmed_attributes`` which fills a blank
``new_attribute_id`` on an item's workspace rows (ambiguous "multiple" features)
so an approved feature stops reading as unmapped in the DB.

Runs standalone (``python tests/test_persist_confirmed_attributes.py``) and under pytest.
"""

import sys
import time
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api import state
from app.db import models
from app.db.session import Base


def _session_factory(db_path: Path):
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(bind=engine)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine), engine


def test_explicit_attribute_fills_blank_rows_and_marks_local(tmp_path: Path):
    SessionLocal, engine = _session_factory(tmp_path / "confirm_explicit.db")
    try:
        db = SessionLocal()
        now_ts = time.time()
        db.add_all(
            [
                # Ambiguous feature: value mapped but attribute left blank by generation.
                models.WorkspaceMapping(
                    legacy_item_id="ITEM-1",
                    legacy_feature_id="ACEGB",
                    legacy_value="HP0WC",
                    new_attribute_id="",
                    new_value="ABS0072",
                    attribute_type="engineering",
                    mapped_from="global",
                    updated_at=now_ts,
                ),
                models.WorkspaceMapping(
                    legacy_item_id="ITEM-1",
                    legacy_feature_id="ACEGB",
                    legacy_value="HP034",
                    new_attribute_id="",
                    new_value="NOT REQUIRED",
                    attribute_type="engineering",
                    mapped_from="",
                    updated_at=now_ts,
                ),
            ]
        )
        db.commit()

        updated = state._persist_confirmed_attributes(
            db, "ITEM-1", ["ACEGB"], {"ACEGB": "COLOROFEDGE"}, actor_id=7
        )
        db.commit()

        assert updated == 2
        rows = (
            db.query(models.WorkspaceMapping)
            .filter(models.WorkspaceMapping.legacy_item_id == "ITEM-1")
            .all()
        )
        for row in rows:
            assert row.new_attribute_id == "COLOROFEDGE"
            assert row.mapped_from == "local"
            assert row.modified_by == "7"
        # Value column must be preserved.
        by_val = {r.legacy_value: r for r in rows}
        assert by_val["HP0WC"].new_value == "ABS0072"
        assert by_val["HP034"].new_value == "NOT REQUIRED"
        db.close()
    finally:
        engine.dispose()


def test_fallback_to_global_candidate_when_attribute_omitted(tmp_path: Path):
    SessionLocal, engine = _session_factory(tmp_path / "confirm_fallback.db")
    try:
        db = SessionLocal()
        now_ts = time.time()
        db.add_all(
            [
                models.GlobalMapping(
                    legacy_feature_ids=["ACEGB"],
                    new_attribute_id="COLOROFEDGE",
                    status="active",
                ),
                models.WorkspaceMapping(
                    legacy_item_id="ITEM-1",
                    legacy_feature_id="ACEGB",
                    legacy_value="HP0WC",
                    new_attribute_id="",
                    new_value="ABS0072",
                    attribute_type="engineering",
                    mapped_from="global",
                    updated_at=now_ts,
                ),
            ]
        )
        db.commit()

        updated = state._persist_confirmed_attributes(
            db, "ITEM-1", ["ACEGB"], {}, actor_id=1
        )
        db.commit()

        assert updated == 1
        row = (
            db.query(models.WorkspaceMapping)
            .filter(models.WorkspaceMapping.legacy_item_id == "ITEM-1")
            .one()
        )
        assert row.new_attribute_id == "COLOROFEDGE"
        assert row.mapped_from == "local"
        db.close()
    finally:
        engine.dispose()


def test_existing_attribute_and_local_rows_are_not_touched(tmp_path: Path):
    SessionLocal, engine = _session_factory(tmp_path / "confirm_skip.db")
    try:
        db = SessionLocal()
        now_ts = time.time()
        db.add_all(
            [
                # Already-mapped feature must keep its attribute.
                models.WorkspaceMapping(
                    legacy_item_id="ITEM-1",
                    legacy_feature_id="ACTRM",
                    legacy_value="TRMTW",
                    new_attribute_id="ColorOfTrim",
                    new_value="MET0038",
                    attribute_type="engineering",
                    mapped_from="global",
                    updated_at=now_ts,
                ),
                # Manual override must never be clobbered.
                models.WorkspaceMapping(
                    legacy_item_id="ITEM-1",
                    legacy_feature_id="ACEGB",
                    legacy_value="HP0WC",
                    new_attribute_id="",
                    new_value="ABS0072",
                    attribute_type="engineering",
                    mapped_from="local",
                    updated_at=now_ts,
                ),
            ]
        )
        db.commit()

        updated = state._persist_confirmed_attributes(
            db, "ITEM-1", ["ACTRM", "ACEGB"], {"ACTRM": "SOMETHING", "ACEGB": "COLOROFEDGE"}, actor_id=1
        )
        db.commit()

        assert updated == 0
        actrm = (
            db.query(models.WorkspaceMapping)
            .filter(models.WorkspaceMapping.legacy_feature_id == "ACTRM")
            .one()
        )
        acegb = (
            db.query(models.WorkspaceMapping)
            .filter(models.WorkspaceMapping.legacy_feature_id == "ACEGB")
            .one()
        )
        assert actrm.new_attribute_id == "ColorOfTrim"
        assert acegb.new_attribute_id == ""
        assert acegb.mapped_from == "local"
        db.close()
    finally:
        engine.dispose()


if __name__ == "__main__":
    import tempfile

    for fn in (
        test_explicit_attribute_fills_blank_rows_and_marks_local,
        test_fallback_to_global_candidate_when_attribute_omitted,
        test_existing_attribute_and_local_rows_are_not_touched,
    ):
        with tempfile.TemporaryDirectory() as d:
            fn(Path(d))
        print(f"ok: {fn.__name__}")
    print("all tests passed")
