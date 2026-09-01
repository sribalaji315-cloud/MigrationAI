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


def test_ignored_group_feature_applies_not_required_to_target_value(tmp_path: Path):
    SessionLocal, engine = _session_factory(tmp_path / "apply_group_features_ignored.db")
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
                    value_status="ignored",
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
            assert row.value_status == "ignored"
            assert row.mapped_from == "group"
            assert row.modified_by == "apply_group_feature"
            assert job.status == "completed"
            assert job.generated_rows == 1
        finally:
            db.close()
    finally:
        state.SessionLocal = original_session_local
        engine.dispose()


def test_active_group_feature_overrides_local_discontinued_row(tmp_path: Path):
    SessionLocal, engine = _session_factory(tmp_path / "apply_group_features_local_override.db")
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
                # Stuck local row: discontinued / NOT REQUIRED from a prior process.
                models.WorkspaceMapping(
                    legacy_item_id="ITEM-1",
                    legacy_feature_id="SUB-FEATURE",
                    legacy_value="OPTION-1",
                    new_attribute_id="OLD-ATTR",
                    new_value="NOT REQUIRED",
                    attribute_type="engineering",
                    mapped_from="local",
                    value_status="discontinued",
                    modified_by="USR-1",
                    updated_at=now_ts,
                ),
                models.GroupFeature(
                    feature_group="GROUP-FEATURE",
                    feature_id="SUB-FEATURE",
                    option="OPTION-1",
                    target_attribute="TARGET-ATTR",
                    target_value="TARGET-VALUE",
                    value_status="approved",
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

            # Active group feature takes ownership of the local row and clears the
            # stale discontinued / NOT REQUIRED status.
            assert row.new_attribute_id == "TARGET-ATTR"
            assert row.new_value == "TARGET-VALUE"
            assert row.value_status is None
            assert row.mapped_from == "group"
            assert row.modified_by == "apply_group_feature"
        finally:
            db.close()
    finally:
        state.SessionLocal = original_session_local
        engine.dispose()


def test_approved_wins_over_discontinued_for_duplicate_option(tmp_path: Path):
    SessionLocal, engine = _session_factory(tmp_path / "apply_group_features_approved_wins.db")
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
                    legacy_value="FB",
                    new_attribute_id="OLD-ATTR",
                    new_value="OLD-VALUE",
                    attribute_type="engineering",
                    mapped_from="global",
                    updated_at=now_ts,
                ),
                # Same (group, feature, option) with two rows: discontinued listed
                # FIRST so order alone would pick it, but approved must win.
                models.GroupFeature(
                    feature_group="GROUP-FEATURE",
                    feature_id="SUB-FEATURE",
                    option="FB",
                    target_attribute="FabricGradeLevel2",
                    target_value="B",
                    value_status="discontinued",
                ),
                models.GroupFeature(
                    feature_group="GROUP-FEATURE",
                    feature_id="SUB-FEATURE",
                    option="FB",
                    target_attribute="MaterialTypeLevel2",
                    target_value="B",
                    value_status="approved",
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
                .filter(models.WorkspaceMapping.legacy_value == "FB")
                .one()
            )

            # Approved row wins over the discontinued sibling.
            assert row.new_attribute_id == "MaterialTypeLevel2"
            assert row.new_value == "B"
            assert row.value_status is None
            assert row.mapped_from == "group"
        finally:
            db.close()
    finally:
        state.SessionLocal = original_session_local
        engine.dispose()


def test_discontinued_option_reuses_single_active_feature_attribute(tmp_path: Path):
    SessionLocal, engine = _session_factory(tmp_path / "apply_group_features_unify_attr.db")
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
                    legacy_value="FA",
                    new_attribute_id="OLD-ATTR",
                    new_value="OLD",
                    attribute_type="engineering",
                    mapped_from="global",
                    updated_at=now_ts,
                ),
                models.WorkspaceMapping(
                    legacy_item_id="ITEM-1",
                    legacy_feature_id="SUB-FEATURE",
                    legacy_value="F0",
                    new_attribute_id="OLD-ATTR",
                    new_value="OLD",
                    attribute_type="engineering",
                    mapped_from="global",
                    updated_at=now_ts,
                ),
                # Active option -> MaterialTypeLevel2 (the sole active attribute).
                models.GroupFeature(
                    feature_group="GROUP-FEATURE",
                    feature_id="SUB-FEATURE",
                    option="FA",
                    target_attribute="MaterialTypeLevel2",
                    target_value="A",
                    value_status="approved",
                ),
                # Discontinued-only option carries a DIFFERENT attribute; it must reuse
                # the feature's single active attribute instead of splitting it.
                models.GroupFeature(
                    feature_group="GROUP-FEATURE",
                    feature_id="SUB-FEATURE",
                    option="F0",
                    target_attribute="FabricGradeLevel2",
                    target_value="0",
                    value_status="discontinued",
                ),
            ]
        )
        db.commit()
        db.close()

        state._run_apply_group_feature_job(job_id)

        db = SessionLocal()
        try:
            rows = {
                r.legacy_value: r
                for r in db.query(models.WorkspaceMapping)
                .filter(models.WorkspaceMapping.legacy_item_id == "ITEM-1")
                .filter(models.WorkspaceMapping.legacy_feature_id == "SUB-FEATURE")
                .all()
            }
            # Both options end up under the single active attribute -> no phantom 2nd attr.
            assert rows["FA"].new_attribute_id == "MaterialTypeLevel2"
            assert rows["FA"].new_value == "A"
            assert rows["F0"].new_attribute_id == "MaterialTypeLevel2"
            assert rows["F0"].new_value == "NOT REQUIRED"
        finally:
            db.close()
    finally:
        state.SessionLocal = original_session_local
        engine.dispose()


def test_feasibility_no_applies_not_required_for_active_group_feature(tmp_path: Path):
    SessionLocal, engine = _session_factory(tmp_path / "apply_group_features_feasibility_no.db")
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
                # Infeasible row under an approved group feature.
                models.WorkspaceMapping(
                    legacy_item_id="ITEM-1",
                    legacy_feature_id="SUB-FEATURE",
                    legacy_value="OPTION-1",
                    new_attribute_id="OLD-ATTR",
                    new_value="OLD-VALUE",
                    attribute_type="engineering",
                    mapped_from="global",
                    feasibility="No",
                    updated_at=now_ts,
                ),
                models.GroupFeature(
                    feature_group="GROUP-FEATURE",
                    feature_id="SUB-FEATURE",
                    option="OPTION-1",
                    target_attribute="TARGET-ATTR",
                    target_value="TARGET-VALUE",
                    value_status="approved",
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

            # Feasibility 'No' forces NOT REQUIRED even though the group feature is approved.
            assert row.new_attribute_id == "TARGET-ATTR"
            assert row.new_value == "NOT REQUIRED"
            assert row.mapped_from == "group"
        finally:
            db.close()
    finally:
        state.SessionLocal = original_session_local
        engine.dispose()


def test_group_feature_overrides_approved_item_and_feature(tmp_path: Path):
    SessionLocal, engine = _session_factory(tmp_path / "apply_group_features_approved_override.db")
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
                # Approved item + an approved (item, feature) pair — both used to be shielded.
                models.BomItem(item_id="ITEM-1", approved_for_migration=1),
                models.ItemFeatureApproval(item_id="ITEM-1", feature_id="SUB-FEATURE"),
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
                    mapped_from="local",
                    updated_at=now_ts,
                ),
                models.GroupFeature(
                    feature_group="GROUP-FEATURE",
                    feature_id="SUB-FEATURE",
                    option="OPTION-1",
                    target_attribute="TARGET-ATTR",
                    target_value="TARGET-VALUE",
                    value_status="approved",
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

            # Group feature overrides even the approved item/feature.
            assert row.new_attribute_id == "TARGET-ATTR"
            assert row.new_value == "TARGET-VALUE"
            assert row.mapped_from == "group"
            assert row.modified_by == "apply_group_feature"
        finally:
            db.close()
    finally:
        state.SessionLocal = original_session_local
        engine.dispose()


def test_ignored_without_target_attribute_applies_not_required(tmp_path: Path):
    SessionLocal, engine = _session_factory(tmp_path / "apply_group_features_ignored_no_target.db")
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
                    mapped_from="local",
                    updated_at=now_ts,
                ),
                # Ignored with no target attribute -> still taken over as NOT REQUIRED + group
                # so the sub-feature is fully group-owned (existing attribute is preserved).
                models.GroupFeature(
                    feature_group="GROUP-FEATURE",
                    feature_id="SUB-FEATURE",
                    option="OPTION-1",
                    target_attribute="",
                    target_value="",
                    value_status="ignored",
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

            # Taken over by group: NOT REQUIRED, ignored, group-sourced; attr preserved.
            assert row.new_value == "NOT REQUIRED"
            assert row.value_status == "ignored"
            assert row.mapped_from == "group"
            assert row.new_attribute_id == "OLD-ATTR"
        finally:
            db.close()
    finally:
        state.SessionLocal = original_session_local
        engine.dispose()


def test_in_progress_wins_over_ignored_for_same_option(tmp_path: Path):
    SessionLocal, engine = _session_factory(tmp_path / "apply_group_features_ignored_precedence.db")
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
                # Same (group, feature, option): ignored loses to in_progress.
                models.GroupFeature(
                    feature_group="GROUP-FEATURE",
                    feature_id="SUB-FEATURE",
                    option="OPTION-1",
                    target_attribute="TARGET-ATTR",
                    target_value="TARGET-VALUE",
                    value_status="ignored",
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

            # in_progress wins: real target value applied, not marked ignored.
            assert row.new_attribute_id == "TARGET-ATTR"
            assert row.new_value == "TARGET-VALUE"
            assert row.value_status != "ignored"
            assert row.mapped_from == "group"
        finally:
            db.close()
    finally:
        state.SessionLocal = original_session_local
        engine.dispose()


def test_group_row_survives_item_regeneration(tmp_path: Path):
    SessionLocal, engine = _session_factory(tmp_path / "apply_group_features_regen.db")
    original_session_local = state.SessionLocal
    state.SessionLocal = SessionLocal

    try:
        db = SessionLocal()
        now_ts = time.time()

        item = models.BomItem(item_id="ITEM-1", description="Item 1")
        db.add(item)
        db.flush()
        db.add(
            models.BomFeature(
                item_id=item.id,
                feature_id="SUB-FEATURE",
                values=["OPTION-1"],
            )
        )
        db.add(
            models.GlobalMapping(
                legacy_feature_ids=["SUB-FEATURE"],
                new_attribute_id="GLOBAL-ATTR",
                attribute_type="engineering",
                value_mappings={"OPTION-1": "GLOBAL-VALUE"},
                status="active",
            )
        )
        # A group-applied row that must be preserved (treated like a local override).
        db.add(
            models.WorkspaceMapping(
                legacy_item_id="ITEM-1",
                legacy_feature_id="SUB-FEATURE",
                legacy_value="OPTION-1",
                new_attribute_id="TARGET-ATTR",
                new_value="COL40",
                attribute_type="engineering",
                mapped_from="group",
                updated_at=now_ts,
            )
        )
        db.commit()
        db.close()

        state._regenerate_item_preserving_local("ITEM-1", "USR-1", "tester", SessionLocal())

        db = SessionLocal()
        try:
            row = (
                db.query(models.WorkspaceMapping)
                .filter(models.WorkspaceMapping.legacy_item_id == "ITEM-1")
                .filter(models.WorkspaceMapping.legacy_feature_id == "SUB-FEATURE")
                .filter(models.WorkspaceMapping.legacy_value == "OPTION-1")
                .one()
            )

            # Group row preserved unchanged; not reverted to the global baseline.
            assert row.mapped_from == "group"
            assert row.new_attribute_id == "TARGET-ATTR"
            assert row.new_value == "COL40"
        finally:
            db.close()
    finally:
        state.SessionLocal = original_session_local
        engine.dispose()


def test_regeneration_fills_values_not_covered_by_group(tmp_path: Path):
    """A group row is preserved, and values without a group row still get a row."""
    SessionLocal, engine = _session_factory(tmp_path / "apply_group_features_gap.db")
    original_session_local = state.SessionLocal
    state.SessionLocal = SessionLocal

    try:
        db = SessionLocal()
        now_ts = time.time()

        item = models.BomItem(item_id="ITEM-1", description="Item 1")
        db.add(item)
        db.flush()
        # Feature has two source options; only OPTION-1 has a group row.
        db.add(
            models.BomFeature(
                item_id=item.id,
                feature_id="SUB-FEATURE",
                values=["OPTION-1", "OPTION-2"],
            )
        )
        db.add(
            models.GlobalMapping(
                legacy_feature_ids=["SUB-FEATURE"],
                new_attribute_id="GLOBAL-ATTR",
                attribute_type="engineering",
                value_mappings={"OPTION-2": "GLOBAL-VALUE"},
                status="active",
            )
        )
        db.add(
            models.WorkspaceMapping(
                legacy_item_id="ITEM-1",
                legacy_feature_id="SUB-FEATURE",
                legacy_value="OPTION-1",
                new_attribute_id="TARGET-ATTR",
                new_value="COL40",
                attribute_type="engineering",
                mapped_from="group",
                updated_at=now_ts,
            )
        )
        db.commit()
        db.close()

        state._regenerate_item_preserving_local("ITEM-1", "USR-1", "tester", SessionLocal())

        db = SessionLocal()
        try:
            rows = {
                r.legacy_value: r
                for r in db.query(models.WorkspaceMapping)
                .filter(models.WorkspaceMapping.legacy_item_id == "ITEM-1")
                .filter(models.WorkspaceMapping.legacy_feature_id == "SUB-FEATURE")
                .all()
            }
            # Both source values now exist in workspace mappings.
            assert set(rows.keys()) == {"OPTION-1", "OPTION-2"}
            # Group row preserved unchanged.
            assert rows["OPTION-1"].mapped_from == "group"
            assert rows["OPTION-1"].new_attribute_id == "TARGET-ATTR"
            assert rows["OPTION-1"].new_value == "COL40"
            # Missing value regenerated from the global baseline.
            assert rows["OPTION-2"].mapped_from == "global"
            assert rows["OPTION-2"].new_attribute_id == "GLOBAL-ATTR"
            assert rows["OPTION-2"].new_value == "GLOBAL-VALUE"
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
    with tempfile.TemporaryDirectory() as tmpdir:
        test_ignored_group_feature_applies_not_required_to_target_value(Path(tmpdir))
    with tempfile.TemporaryDirectory() as tmpdir:
        test_ignored_without_target_attribute_is_skipped(Path(tmpdir))
    with tempfile.TemporaryDirectory() as tmpdir:
        test_in_progress_wins_over_ignored_for_same_option(Path(tmpdir))
    with tempfile.TemporaryDirectory() as tmpdir:
        test_group_row_survives_item_regeneration(Path(tmpdir))
    with tempfile.TemporaryDirectory() as tmpdir:
        test_regeneration_fills_values_not_covered_by_group(Path(tmpdir))
    print("apply group feature tests passed")