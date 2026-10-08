"""Focused tests for the Where Used usage endpoints.

Runs standalone (``python tests/test_where_used.py``) and under pytest.
"""

import sys
import time
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api import where_used
from app.db import models
from app.db.session import Base


def _session(db_path: Path):
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    # The module cache is keyed by query params only, so it must be dropped
    # between tests that use different temporary databases.
    where_used.invalidate_where_used_cache()
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)()


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


def _seed(db):
    db.add_all([
        models.BomItem(id=1, item_id="ITEM-1", description="First", category="TABLES", product_type="DINING", priority=1),
        models.BomItem(id=2, item_id="ITEM-2", description="Second", category="CHAIRS", product_type="OFFICE", priority=2),
    ])
    db.add_all([
        models.BomFeature(item_id=1, feature_id="ACOL", description="Colour", values=["RED", "BLUE", "NEVERMAPPED"]),
        models.BomFeature(item_id=2, feature_id="ACOL", description="Colour", values=["RED"]),
        models.BomFeature(item_id=1, feature_id="AUNUSED", description="Never mapped", values=["X"]),
        # values_json is also stored as an object on ~43% of rows.
        models.BomFeature(
            item_id=2,
            feature_id="ADICT",
            description="Object shaped",
            values={"values": ["CBZD"], "valueDescriptions": {"CBZD": "CBZD"}, "valueTillDates": {}},
        ),
    ])
    db.add_all([
        _mapping("ITEM-1", "ACOL", "RED", "ColorOfFabric", "Scarlet"),
        _mapping("ITEM-2", "ACOL", "RED", "ColorOfFabric", "Scarlet"),
        _mapping("ITEM-1", "ACOL", "BLUE", "ColorOfFabric", "Navy"),
        # Attribute-only row: blank legacy value must not count as a value.
        _mapping("ITEM-1", "ASIZE", "", "Width", ""),
        # Sentinels must surface as their own rows, not be dropped.
        _mapping("ITEM-2", "ASIZE", "BIG", "UNMAPPED", "UNMAPPED"),
        _mapping("ITEM-2", "ATRIM", "GOLD", "TrimType", "NOT REQUIRED"),
    ])
    db.add(models.Classification(
        class_id="TABLE",
        class_name="Table",
        attributes=[
            {"attributeId": "ColorOfFabric", "description": "Fabric colour", "allowedValues": ["Scarlet", "Navy", "Ochre"]},
            {"attributeId": "OrphanAttribute", "description": "Declared but unused", "allowedValues": ["A"]},
        ],
    ))
    db.commit()


def test_target_attributes_counts_and_sentinels(tmp_path: Path):
    db = _session(tmp_path / "wu1.db")
    try:
        _seed(db)
        result = where_used.list_target_attribute_usage(db=db, limit=50, offset=0)
        rows = {r["attributeId"]: r for r in result["items"]}

        color = rows["ColorOfFabric"]
        assert color["itemCount"] == 2
        assert color["legacyFeatureCount"] == 1
        assert color["valueCount"] == 2  # Scarlet + Navy
        assert color["inClassifications"] is True

        # Blank legacy_value contributes no value even though the row exists.
        assert rows["Width"]["itemCount"] == 1
        assert rows["Width"]["valueCount"] == 0

        # Sentinels are their own rows and are flagged.
        assert rows["UNMAPPED"]["isSentinel"] is True
        assert rows["TrimType"]["valueCount"] == 0  # NOT REQUIRED is not a real value

        # Declared-but-unused attribute shows with zero usage.
        assert rows["OrphanAttribute"]["itemCount"] == 0
        assert rows["OrphanAttribute"]["inClassifications"] is True

        # Default sort is item count descending.
        counts = [r["itemCount"] for r in result["items"]]
        assert counts == sorted(counts, reverse=True)
    finally:
        db.close()


def test_target_values_includes_unused_allowed_values(tmp_path: Path):
    db = _session(tmp_path / "wu2.db")
    try:
        _seed(db)
        result = where_used.list_target_value_usage(db=db, attributeId="ColorOfFabric", limit=50, offset=0)
        rows = {r["value"]: r for r in result["items"]}

        assert rows["Scarlet"]["itemCount"] == 2
        assert rows["Scarlet"]["legacyValueCount"] == 1
        assert rows["Navy"]["itemCount"] == 1
        # Declared in the classification but nothing maps to it.
        assert rows["Ochre"]["itemCount"] == 0
        assert rows["Ochre"]["inClassifications"] is True
    finally:
        db.close()


def test_legacy_features_counts_and_unmapped_catalogue(tmp_path: Path):
    db = _session(tmp_path / "wu3.db")
    try:
        _seed(db)
        result = where_used.list_legacy_feature_usage(db=db, limit=50, offset=0)
        rows = {r["featureId"]: r for r in result["items"]}

        assert rows["ACOL"]["itemCount"] == 2
        assert rows["ACOL"]["targetAttributeCount"] == 1
        assert rows["ACOL"]["targetValueCount"] == 2
        assert rows["ACOL"]["legacyValueCount"] == 2

        # ASIZE maps to Width and to UNMAPPED; only Width is a real target.
        assert rows["ASIZE"]["targetAttributeCount"] == 1

        # On a BOM item but never mapped -> zero usage, still listed.
        assert rows["AUNUSED"]["itemCount"] == 0
        assert rows["AUNUSED"]["inBom"] is True
    finally:
        db.close()


def test_legacy_values_includes_bom_options_without_mappings(tmp_path: Path):
    db = _session(tmp_path / "wu4.db")
    try:
        _seed(db)
        result = where_used.list_legacy_value_usage(db=db, featureId="ACOL", limit=50, offset=0)
        rows = {r["value"]: r for r in result["items"]}

        assert rows["RED"]["itemCount"] == 2
        assert rows["RED"]["targetAttributeCount"] == 1
        assert rows["BLUE"]["itemCount"] == 1
        # Present on a BOM item but absent from workspace_mappings.
        assert rows["NEVERMAPPED"]["itemCount"] == 0
        assert rows["NEVERMAPPED"]["inBom"] is True
    finally:
        db.close()


def test_items_panel_returns_bom_detail_and_paginates(tmp_path: Path):
    db = _session(tmp_path / "wu5.db")
    try:
        _seed(db)
        page = where_used.list_where_used_items(side="target", key="ColorOfFabric", db=db, limit=1, offset=0)
        assert page["hasMore"] is True
        assert page["items"][0]["itemId"] == "ITEM-1"
        assert page["items"][0]["category"] == "TABLES"
        assert page["items"][0]["priority"] == 1

        scoped = where_used.list_where_used_items(side="target", key="ColorOfFabric", value="Navy", db=db, limit=50, offset=0)
        assert [i["itemId"] for i in scoped["items"]] == ["ITEM-1"]
        assert scoped["hasMore"] is False

        legacy = where_used.list_where_used_items(side="legacy", key="ACOL", value="RED", db=db, limit=50, offset=0)
        assert [i["itemId"] for i in legacy["items"]] == ["ITEM-1", "ITEM-2"]
    finally:
        db.close()


def test_counterparts_returns_opposite_side(tmp_path: Path):
    db = _session(tmp_path / "wu6.db")
    try:
        _seed(db)
        forward = where_used.list_where_used_counterparts(side="legacy", key="ACOL", db=db, limit=200)
        assert forward["side"] == "target"
        assert {(i["key"], i["value"], i["itemCount"]) for i in forward["items"]} == {
            ("ColorOfFabric", "Scarlet", 2),
            ("ColorOfFabric", "Navy", 1),
        }

        backward = where_used.list_where_used_counterparts(side="target", key="ColorOfFabric", value="Scarlet", db=db, limit=200)
        assert backward["side"] == "legacy"
        assert [(i["key"], i["value"], i["itemCount"]) for i in backward["items"]] == [("ACOL", "RED", 2)]
    finally:
        db.close()


def test_attribute_type_filter_scopes_counts(tmp_path: Path):
    db = _session(tmp_path / "wu7.db")
    try:
        _seed(db)
        db.add(_mapping("ITEM-1", "AMKT", "X", "MarketingBlurb", "Y", attribute_type="marketing"))
        db.commit()
        where_used.invalidate_where_used_cache()

        marketing = where_used.list_target_attribute_usage(db=db, attributeType="marketing", limit=50, offset=0)
        ids = {r["attributeId"] for r in marketing["items"]}
        assert ids == {"MarketingBlurb"}
        # Catalogue-only rows are omitted because they have no attribute type.
        assert "OrphanAttribute" not in ids
    finally:
        db.close()


def test_options_are_catalogue_only(tmp_path: Path):
    """Option A: dropdowns list catalogue entries, never ad-hoc mapped values."""
    db = _session(tmp_path / "wu8.db")
    try:
        _seed(db)

        attrs = [o["value"] for o in where_used.list_where_used_options(scope="targetAttributes", db=db, limit=50)["items"]]
        # Width / TrimType / UNMAPPED exist only in workspace_mappings, so they are excluded.
        assert attrs == ["ColorOfFabric", "OrphanAttribute"]

        feats = [o["value"] for o in where_used.list_where_used_options(scope="legacyFeatures", db=db, limit=50)["items"]]
        # ASIZE / ATRIM are mapped but absent from bom_features.
        assert feats == ["ACOL", "ADICT", "AUNUSED"]

        all_vals = [o["value"] for o in where_used.list_where_used_options(scope="targetValues", db=db, limit=50)["items"]]
        assert all_vals == ["A", "Navy", "Ochre", "Scarlet"]

        scoped = [o["value"] for o in where_used.list_where_used_options(scope="targetValues", parent="ColorOfFabric", db=db, limit=50)["items"]]
        assert scoped == ["Navy", "Ochre", "Scarlet"]

        legacy_vals = [o["value"] for o in where_used.list_where_used_options(scope="legacyValues", parent="ACOL", db=db, limit=50)["items"]]
        assert legacy_vals == ["BLUE", "NEVERMAPPED", "RED"]

        searched = where_used.list_where_used_options(scope="targetValues", search="nav", db=db, limit=50)
        assert [o["value"] for o in searched["items"]] == ["Navy"]
        assert searched["total"] == 1
    finally:
        db.close()


def test_object_shaped_values_json_yields_values_not_keys(tmp_path: Path):
    """values_json can be {"values": [...], "valueDescriptions": {...}}; the
    wrapper keys must never surface as options."""
    db = _session(tmp_path / "wu11.db")
    try:
        _seed(db)
        scoped = [o["value"] for o in where_used.list_where_used_options(scope="legacyValues", parent="ADICT", db=db, limit=50)["items"]]
        assert scoped == ["CBZD"]

        every = [o["value"] for o in where_used.list_where_used_options(scope="legacyValues", db=db, limit=50)["items"]]
        assert "CBZD" in every
        for leaked in ("values", "valueDescriptions", "valueTillDates"):
            assert leaked not in every

        # The same normalisation feeds the zero-usage catalogue rows.
        rows = where_used.list_legacy_value_usage(db=db, featureId="ADICT", limit=50, offset=0)
        assert [r["value"] for r in rows["items"]] == ["CBZD"]
    finally:
        db.close()


def test_options_paginate_with_total(tmp_path: Path):
    db = _session(tmp_path / "wu9.db")
    try:
        _seed(db)
        page = where_used.list_where_used_options(scope="targetValues", db=db, limit=2)
        assert len(page["items"]) == 2
        assert page["hasMore"] is True
        assert page["total"] == 4
    finally:
        db.close()


def test_keys_filter_restricts_rows(tmp_path: Path):
    db = _session(tmp_path / "wu10.db")
    try:
        _seed(db)

        attrs = where_used.list_target_attribute_usage(db=db, keys="ColorOfFabric", limit=50, offset=0)
        assert [r["attributeId"] for r in attrs["items"]] == ["ColorOfFabric"]

        multi = where_used.list_target_attribute_usage(db=db, keys="ColorOfFabric,Width", limit=50, offset=0)
        assert {r["attributeId"] for r in multi["items"]} == {"ColorOfFabric", "Width"}

        # Matching is case-insensitive.
        lower = where_used.list_target_attribute_usage(db=db, keys="colorOFfabric", limit=50, offset=0)
        assert [r["attributeId"] for r in lower["items"]] == ["ColorOfFabric"]

        values = where_used.list_target_value_usage(db=db, attributeId="ColorOfFabric", keys="Navy", limit=50, offset=0)
        assert [r["value"] for r in values["items"]] == ["Navy"]

        feats = where_used.list_legacy_feature_usage(db=db, keys="ACOL", limit=50, offset=0)
        assert [r["featureId"] for r in feats["items"]] == ["ACOL"]

        legacy_values = where_used.list_legacy_value_usage(db=db, featureId="ACOL", keys="RED", limit=50, offset=0)
        assert [r["value"] for r in legacy_values["items"]] == ["RED"]
    finally:
        db.close()


if __name__ == "__main__":
    import tempfile

    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            with tempfile.TemporaryDirectory() as tmp:
                fn(Path(tmp))
            print(f"ok {name}")
    print("all where-used tests passed")
