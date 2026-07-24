"""Focused tests for applying group feature mappings to workspace rows.

Runs standalone (``python tests/test_apply_group_features.py``) and is also
compatible with pytest if it is installed.
"""

import sys
import tempfile
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


def test_discontinued_group_feature_applies_not_required_to_target_value(tmp_path: Path):
    SessionLocal, engine = _session_factory(tmp_path / "apply_group_features.db")
    original_session_local = state.SessionLocal
    state.SessionLocal = SessionLocal

    try:
        db = SessionLocal()
        now_ts = time.time()
        job = models.ApplyGroupFeatureJob(status="queued", updated_at=now_ts)
        db.add(job)
        db.flush()
        job_id = int(job.id)

        db.add_all(
            [
                models.WorkspaceMapping(
                    legacy_item_id="ITEM-1",
                    legacy_feature_id="GROUP-FEATURE",
                    legacy_value="",
                    new_attribute_id="",
                    new_value="",
                    attribute_type="",
                    mapped_from="global",
                    updated_at=now_ts,
                ),
                models.WorkspaceMapping(
                    legacy_item_id="ITEM-1",
                    legacy_feature_id="SUB-FEATURE",
                    legacy_value="OPTION-1",
                    new_attribute_id="OLD-ATTR",
                    new_value="OLD-VALUE",
                    attribute_type="engineering",
                    mapped_from="global",
                    updated_at=now_ts,
                ),
                models.GroupFeature(
                    feature_group="GROUP-FEATURE",
                    feature_id="SUB-FEATURE",
                    option="OPTION-1",
                    target_attribute="TARGET-ATTR",
                    target_value="TARGET-VALUE",
                    value_status="discontinued",
                ),
            ]
        )
        db.commit()
        db.close()

        state._run_apply_group_feature_job(job_id)

        db = SessionLocal()
        try:
            row = (
                db.query(models.WorkspaceMapping)
                .filter(models.WorkspaceMapping.legacy_item_id == "ITEM-1")
                .filter(models.WorkspaceMapping.legacy_feature_id == "SUB-FEATURE")
                .filter(models.WorkspaceMapping.legacy_value == "OPTION-1")
                .one()
            )
            job = db.query(models.ApplyGroupFeatureJob).filter(models.ApplyGroupFeatureJob.id == job_id).one()

            assert row.new_attribute_id == "TARGET-ATTR"
            assert row.new_value == "NOT REQUIRED"
            assert row.value_status == "discontinued"
            assert row.mapped_from == "group"
            assert row.modified_by == "apply_group_feature"
            assert job.status == "completed"
            assert job.generated_rows == 1
        finally:
            db.close()
    finally:
        state.SessionLocal = original_session_local
        engine.dispose()


def test_in_progress_wins_over_discontinued_for_same_option(tmp_path: Path):
    SessionLocal, engine = _session_factory(tmp_path / "apply_group_features_precedence.db")
    original_session_local = state.SessionLocal
    state.SessionLocal = SessionLocal

    try:
        db = SessionLocal()
        now_ts = time.time()
        job = models.ApplyGroupFeatureJob(status="queued", updated_at=now_ts)
        db.add(job)
        db.flush()
        job_id = int(job.id)

        db.add_all(
            [
                models.WorkspaceMapping(
                    legacy_item_id="ITEM-1",
                    legacy_feature_id="GROUP-FEATURE",
                    legacy_value="",
                    new_attribute_id="",
                    new_value="",
                    attribute_type="",
                    mapped_from="global",
                    updated_at=now_ts,
                ),
                models.WorkspaceMapping(
                    legacy_item_id="ITEM-1",
                    legacy_feature_id="SUB-FEATURE",
                    legacy_value="OPTION-1",
                    new_attribute_id="OLD-ATTR",
                    new_value="OLD-VALUE",
                    attribute_type="engineering",
                    mapped_from="global",
                    updated_at=now_ts,
                ),
                # Same (group, feature, option) with conflicting statuses.
                models.GroupFeature(
                    feature_group="GROUP-FEATURE",
                    feature_id="SUB-FEATURE",
                    option="OPTION-1",
                    target_attribute="TARGET-ATTR",
                    target_value="TARGET-VALUE",
                    value_status="discontinued",
                ),
                models.GroupFeature(
                    feature_group="GROUP-FEATURE",
                    feature_id="SUB-FEATURE",
                    option="OPTION-1",
                    target_attribute="TARGET-ATTR",
                    target_value="TARGET-VALUE",
                    value_status="in_progress",
                ),
            ]
        )
        db.commit()
        db.close()

        state._run_apply_group_feature_job(job_id)

        db = SessionLocal()
        try:
            row = (
                db.query(models.WorkspaceMapping)
                .filter(models.WorkspaceMapping.legacy_item_id == "ITEM-1")
                .filter(models.WorkspaceMapping.legacy_feature_id == "SUB-FEATURE")
                .filter(models.WorkspaceMapping.legacy_value == "OPTION-1")
                .one()
            )

            # in_progress wins: real target value applied, not marked discontinued.
            assert row.new_attribute_id == "TARGET-ATTR"
            assert row.new_value == "TARGET-VALUE"
            assert row.value_status != "discontinued"
            assert row.mapped_from == "group"
        finally:
            db.close()
    finally:
        state.SessionLocal = original_session_local
        engine.dispose()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmpdir:
        test_discontinued_group_feature_applies_not_required_to_target_value(Path(tmpdir))
    with tempfile.TemporaryDirectory() as tmpdir:
        test_in_progress_wins_over_discontinued_for_same_option(Path(tmpdir))
    print("apply group feature tests passed")