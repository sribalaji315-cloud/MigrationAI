"""add bom and global mapping tables

Revision ID: 0003_add_bom_and_mappings
Revises: 0002_add_classifications
Create Date: 2026-02-22 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0003_add_bom_and_mappings"
down_revision = "0002_add_classifications"
branch_labels = None
depends_on = None


def upgrade():
    # BOM items
    op.create_table(
        "bom_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("item_id", sa.String(), nullable=False, unique=True),
        sa.Column("description", sa.String(), nullable=True),
    )

    # BOM features (one-to-many with bom_items)
    op.create_table(
        "bom_features",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("item_id", sa.Integer(), sa.ForeignKey("bom_items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("feature_id", sa.String(), nullable=False),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("values_json", sa.JSON(), nullable=True),
    )

    # Global mappings
    op.create_table(
        "global_mappings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("legacy_feature_ids", sa.JSON(), nullable=False),
        sa.Column("new_attribute_id", sa.String(), nullable=False),
        sa.Column("value_mappings", sa.JSON(), nullable=True),
    )

    # Attempt a best-effort migration of existing BOM and mappings
    # data from the app_state JSON blob into the new tables so that
    # existing environments retain their current content.
    conn = op.get_bind()
    try:
        res = conn.execute(sa.text("SELECT id, state FROM app_state WHERE id = 1"))
        row = res.first()
    except Exception:
        row = None

    if row is not None and row[1]:
        import json
        state_raw = row[1]
        # Parse JSON if it's a string (SQLite stores JSON as TEXT)
        if isinstance(state_raw, str):
            state = json.loads(state_raw)
        else:
            state = state_raw or {}
        bom = state.get("bom") or []
        mappings = state.get("mappings") or []

        # Insert BOM items and features
        for item in bom:
            item_id = item.get("itemId")
            if not item_id:
                continue
            description = item.get("description") or ""
            result = conn.execute(
                sa.text(
                    "INSERT INTO bom_items (item_id, description) VALUES (:item_id, :description) RETURNING id"
                ),
                {"item_id": item_id, "description": description},
            )
            bom_pk = result.scalar()
            for feat in item.get("features") or []:
                conn.execute(
                    sa.text(
                        """
                        INSERT INTO bom_features (item_id, feature_id, description, values_json)
                        VALUES (:item_id, :feature_id, :description, :values_json)
                        """
                    ),
                    {
                        "item_id": bom_pk,
                        "feature_id": feat.get("featureId"),
                        "description": feat.get("description") or "",
                        "values_json": feat.get("values") or [],
                    },
                )

        # Insert global mappings
        for m in mappings:
            conn.execute(
                sa.text(
                    """
                    INSERT INTO global_mappings (legacy_feature_ids, new_attribute_id, value_mappings)
                    VALUES (:legacy_feature_ids, :new_attribute_id, :value_mappings)
                    """
                ),
                {
                    "legacy_feature_ids": m.get("legacyFeatureIds") or [],
                    "new_attribute_id": m.get("newAttributeId") or "",
                    "value_mappings": m.get("valueMappings") or {},
                },
            )


def downgrade():
    op.drop_table("global_mappings")
    op.drop_table("bom_features")
    op.drop_table("bom_items")
