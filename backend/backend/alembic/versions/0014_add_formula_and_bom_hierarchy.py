"""Add formula column to bom_features and workspace_mappings, create bom_hierarchy table

Revision ID: 0014
Revises: 0013_add_priority_and_condition
Create Date: 2026-04-05

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0014_add_formula_and_bom_hierarchy"
down_revision = "0013_add_priority_and_condition"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bom_features", sa.Column("formula", sa.String(), nullable=True))
    op.add_column("workspace_mappings", sa.Column("formula", sa.String(), nullable=True))

    op.create_table(
        "bom_hierarchy",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("level", sa.Integer(), nullable=True),
        sa.Column("item_id", sa.String(), nullable=False, index=True),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("qty", sa.Float(), nullable=True),
        sa.Column("unit", sa.String(), nullable=True),
        sa.Column("condition", sa.String(), nullable=True),
        sa.Column("formula", sa.String(), nullable=True),
        sa.Column("created_at", sa.Float(), nullable=True),
        sa.Column("created_by", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("bom_hierarchy")
    op.drop_column("workspace_mappings", "formula")
    op.drop_column("bom_features", "formula")
