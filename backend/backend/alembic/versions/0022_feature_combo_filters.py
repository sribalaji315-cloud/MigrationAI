"""Add attribute_type and priorities_json to feature_combinations

Revision ID: 0022_feature_combo_filters
Revises: 0021_add_feature_combinations
Create Date: 2026-04-09

"""
from alembic import op
import sqlalchemy as sa

revision = "0022_feature_combo_filters"
down_revision = "0021_add_feature_combinations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("feature_combinations") as batch_op:
        batch_op.add_column(sa.Column("attribute_type", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("priorities_json", sa.JSON(), nullable=True))
        batch_op.create_index("ix_feature_combinations_attr_type", ["attribute_type"])


def downgrade() -> None:
    with op.batch_alter_table("feature_combinations") as batch_op:
        batch_op.drop_index("ix_feature_combinations_attr_type")
        batch_op.drop_column("priorities_json")
        batch_op.drop_column("attribute_type")
