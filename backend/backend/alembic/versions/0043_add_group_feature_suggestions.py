"""Add suggested_attributes and suggested_values columns to group_features

Revision ID: 0043_add_group_feature_suggestions
Revises: 0042_add_group_features
Create Date: 2026-04-16

"""
from alembic import op
import sqlalchemy as sa

revision = "0043_add_group_feature_suggestions"
down_revision = "0042_add_group_features"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("group_features", sa.Column("suggested_attributes", sa.JSON(), nullable=True))
    op.add_column("group_features", sa.Column("suggested_values", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("group_features", "suggested_values")
    op.drop_column("group_features", "suggested_attributes")
