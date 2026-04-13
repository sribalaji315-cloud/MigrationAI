"""Add legacy_feature_footprint and legacy_value_footprint columns

Revision ID: 0037_add_legacy_footprints
Revises: 0036_add_manifest_item_stats
Create Date: 2026-04-13

"""
from alembic import op
import sqlalchemy as sa

revision = "0037_add_legacy_footprints"
down_revision = "0036_add_manifest_item_stats"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("merged_workspace_mappings") as batch_op:
        batch_op.add_column(sa.Column("legacy_feature_footprint", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("legacy_value_footprint", sa.String(), nullable=True))
        batch_op.create_index("ix_merged_ws_legacy_feature_fp", ["legacy_feature_footprint"])
        batch_op.create_index("ix_merged_ws_legacy_value_fp", ["legacy_value_footprint"])

    with op.batch_alter_table("manifest_item_stats") as batch_op:
        batch_op.add_column(sa.Column("legacy_feature_footprint", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("manifest_item_stats") as batch_op:
        batch_op.drop_column("legacy_feature_footprint")

    with op.batch_alter_table("merged_workspace_mappings") as batch_op:
        batch_op.drop_index("ix_merged_ws_legacy_value_fp")
        batch_op.drop_index("ix_merged_ws_legacy_feature_fp")
        batch_op.drop_column("legacy_value_footprint")
        batch_op.drop_column("legacy_feature_footprint")
