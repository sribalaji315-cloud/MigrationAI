"""Add D365 mapping columns and status to feature_combinations

Revision ID: 0023_feature_combo_d365_status
Revises: 0022_feature_combo_filters
Create Date: 2026-04-09
"""

from alembic import op
import sqlalchemy as sa

revision = "0023_feature_combo_d365_status"
down_revision = "0022_feature_combo_filters"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("feature_combinations") as batch_op:
        batch_op.add_column(sa.Column("legacy_value_count", sa.Integer(), nullable=False, server_default="0"))
        batch_op.add_column(sa.Column("d365_attribute_id", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("d365_values_json", sa.JSON(), nullable=True))
        batch_op.add_column(sa.Column("mapped_value_count", sa.Integer(), nullable=False, server_default="0"))
        batch_op.add_column(sa.Column("mapping_status", sa.String(), nullable=False, server_default="unmapped"))
        batch_op.create_index("ix_feature_combinations_mapping_status", ["mapping_status"])


def downgrade():
    with op.batch_alter_table("feature_combinations") as batch_op:
        batch_op.drop_index("ix_feature_combinations_mapping_status")
        batch_op.drop_column("mapping_status")
        batch_op.drop_column("mapped_value_count")
        batch_op.drop_column("d365_values_json")
        batch_op.drop_column("d365_attribute_id")
        batch_op.drop_column("legacy_value_count")
