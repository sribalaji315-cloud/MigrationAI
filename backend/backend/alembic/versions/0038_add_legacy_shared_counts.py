"""Add legacy_value_footprint, legacy_combo_item_count, legacy_shared_vl_count to manifest_item_stats

Revision ID: 0038_add_legacy_shared_counts
Revises: 0037_add_legacy_footprints
Create Date: 2026-04-13

"""
from alembic import op
import sqlalchemy as sa

revision = "0038_add_legacy_shared_counts"
down_revision = "0037_add_legacy_footprints"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("manifest_item_stats") as batch_op:
        batch_op.add_column(sa.Column("legacy_value_footprint", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("legacy_combo_item_count", sa.Integer(), nullable=False, server_default="1"))
        batch_op.add_column(sa.Column("legacy_shared_vl_count", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    with op.batch_alter_table("manifest_item_stats") as batch_op:
        batch_op.drop_column("legacy_shared_vl_count")
        batch_op.drop_column("legacy_combo_item_count")
        batch_op.drop_column("legacy_value_footprint")
