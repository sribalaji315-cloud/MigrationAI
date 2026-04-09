"""Add item_ids_json column to feature_combinations

Revision ID: 0024_fc_item_ids_json
Revises: 0023_feature_combo_d365_status
Create Date: 2026-04-09
"""

from alembic import op
import sqlalchemy as sa

revision = "0024_fc_item_ids_json"
down_revision = "0023_feature_combo_d365_status"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("feature_combinations") as batch_op:
        batch_op.add_column(sa.Column("item_ids_json", sa.JSON(), nullable=True))


def downgrade():
    with op.batch_alter_table("feature_combinations") as batch_op:
        batch_op.drop_column("item_ids_json")
