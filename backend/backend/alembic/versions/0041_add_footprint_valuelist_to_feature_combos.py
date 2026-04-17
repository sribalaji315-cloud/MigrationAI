"""Add footprint and value_list_id to feature_combinations

Revision ID: 0041_add_footprint_valuelist_to_feature_combos
Revises: 0040_add_candidate_attribute_ids_json
Create Date: 2026-04-15

"""
from alembic import op
import sqlalchemy as sa

revision = "0041_add_footprint_valuelist_to_feature_combos"
down_revision = "0040_add_candidate_attribute_ids_json"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("feature_combinations") as batch_op:
        batch_op.add_column(sa.Column("footprint", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("value_list_id", sa.String(), nullable=True))
        batch_op.create_index("ix_feature_combinations_footprint", ["footprint"])
        batch_op.create_index("ix_feature_combinations_value_list_id", ["value_list_id"])


def downgrade() -> None:
    with op.batch_alter_table("feature_combinations") as batch_op:
        batch_op.drop_index("ix_feature_combinations_value_list_id")
        batch_op.drop_index("ix_feature_combinations_footprint")
        batch_op.drop_column("value_list_id")
        batch_op.drop_column("footprint")
