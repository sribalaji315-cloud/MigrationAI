"""Add conversion column to bom_hierarchy

Revision ID: 0048_add_conversion_to_bom_hierarchy
Revises: 0047_add_group_feature_comments
Create Date: 2026-07-24

"""
from alembic import op
import sqlalchemy as sa


revision = "0048_add_conversion_to_bom_hierarchy"
down_revision = "0047_add_group_feature_comments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    cols = [c["name"] for c in inspector.get_columns("bom_hierarchy")]
    if "conversion" not in cols:
        op.add_column("bom_hierarchy", sa.Column("conversion", sa.String(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    cols = [c["name"] for c in inspector.get_columns("bom_hierarchy")]
    if "conversion" in cols:
        op.drop_column("bom_hierarchy", "conversion")
