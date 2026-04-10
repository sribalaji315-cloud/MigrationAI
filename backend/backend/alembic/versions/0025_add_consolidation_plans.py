"""Add consolidation_plans table

Revision ID: 0025_add_consolidation_plans
Revises: 0024_fc_item_ids_json
Create Date: 2026-04-09
"""

from alembic import op
import sqlalchemy as sa

revision = "0025_add_consolidation_plans"
down_revision = "0024_fc_item_ids_json"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "consolidation_plans",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("feature_id", sa.String(), nullable=False, unique=True, index=True),
        sa.Column("strategy", sa.String(), nullable=False),
        sa.Column("lists_needed", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("canonical_lists_json", sa.JSON(), nullable=False),
        sa.Column("item_assignments_json", sa.JSON(), nullable=False),
        sa.Column("total_noise", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_noise_per_item", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.String(), nullable=True),
        sa.Column("created_at", sa.Float(), nullable=True),
        sa.Column("updated_by", sa.String(), nullable=True),
        sa.Column("updated_at", sa.Float(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("consolidation_plans")
