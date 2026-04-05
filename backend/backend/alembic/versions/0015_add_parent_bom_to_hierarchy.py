"""Add parent_bom column to bom_hierarchy

Revision ID: 0015
Revises: 0014_add_formula_and_bom_hierarchy
Create Date: 2026-04-05

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0015_add_parent_bom_to_hierarchy"
down_revision = "0014_add_formula_and_bom_hierarchy"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bom_hierarchy", sa.Column("parent_bom", sa.String(), nullable=True))
    op.create_index("ix_bom_hierarchy_parent_bom", "bom_hierarchy", ["parent_bom"])


def downgrade() -> None:
    op.drop_index("ix_bom_hierarchy_parent_bom", table_name="bom_hierarchy")
    op.drop_column("bom_hierarchy", "parent_bom")
