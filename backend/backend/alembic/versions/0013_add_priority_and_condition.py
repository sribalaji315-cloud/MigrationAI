"""Add priority to bom_items and condition to bom_features and workspace_mappings

Revision ID: 0013
Revises: 0012
Create Date: 2026-04-04

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0013_add_priority_and_condition"
down_revision = "0012_add_version_and_audit_columns"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bom_items", sa.Column("priority", sa.Integer(), nullable=True))
    op.create_index("ix_bom_items_priority", "bom_items", ["priority"])

    op.add_column("bom_features", sa.Column("condition", sa.String(), nullable=True))

    op.add_column("workspace_mappings", sa.Column("condition", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("workspace_mappings", "condition")
    op.drop_column("bom_features", "condition")
    op.drop_index("ix_bom_items_priority", table_name="bom_items")
    op.drop_column("bom_items", "priority")
