"""Add manifest_item_stats table for pre-computed item summary counts

Revision ID: 0036_add_manifest_item_stats
Revises: 0035_add_merge_job_and_merged_footprints
Create Date: 2026-04-12

"""
from alembic import op
import sqlalchemy as sa

revision = "0036_add_manifest_item_stats"
down_revision = "0035_add_merge_job_and_merged_footprints"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "manifest_item_stats",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("item_id", sa.String(), nullable=False, unique=True, index=True),
        sa.Column("attr_count", sa.Integer(), nullable=False, default=0),
        sa.Column("mapped_count", sa.Integer(), nullable=False, default=0),
        sa.Column("combo_item_count", sa.Integer(), nullable=False, default=1),
        sa.Column("shared_vl_count", sa.Integer(), nullable=False, default=0),
        sa.Column("attribute_footprint", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("manifest_item_stats")
