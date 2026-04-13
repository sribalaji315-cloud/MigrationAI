"""Add footprint component list columns to manifest_item_stats

Revision ID: 0039_add_footprint_component_lists
Revises: 0038_add_legacy_shared_counts
Create Date: 2026-04-13

"""
from alembic import op
import sqlalchemy as sa

revision = "0039_add_footprint_component_lists"
down_revision = "0038_add_legacy_shared_counts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("manifest_item_stats") as batch_op:
        batch_op.add_column(sa.Column("footprint_attr_list", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("footprint_legacy_feature_list", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("footprint_value_list", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("footprint_legacy_value_list", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("manifest_item_stats") as batch_op:
        batch_op.drop_column("footprint_legacy_value_list")
        batch_op.drop_column("footprint_value_list")
        batch_op.drop_column("footprint_legacy_feature_list")
        batch_op.drop_column("footprint_attr_list")
