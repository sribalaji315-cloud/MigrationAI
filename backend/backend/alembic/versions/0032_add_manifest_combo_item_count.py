"""Add combo_item_count to migration_manifest_entries

Revision ID: 0032_add_manifest_combo_item_count
Revises: 0031_add_merged_workspace_mappings
Create Date: 2026-04-12

"""
from alembic import op
import sqlalchemy as sa

revision = "0032_add_manifest_combo_item_count"
down_revision = "0031_add_merged_workspace_mappings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "migration_manifest_entries",
        sa.Column("combo_item_count", sa.Integer(), nullable=False, server_default="1"),
    )


def downgrade() -> None:
    op.drop_column("migration_manifest_entries", "combo_item_count")
