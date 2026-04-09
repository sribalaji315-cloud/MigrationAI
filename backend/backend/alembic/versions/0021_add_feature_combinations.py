"""Add feature_combinations and feature_combination_jobs tables

Revision ID: 0021_add_feature_combinations
Revises: 0020_drop_app_state
Create Date: 2026-04-09

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0021_add_feature_combinations"
down_revision = "0020_drop_app_state"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "feature_combination_jobs",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("status", sa.String(), nullable=False, index=True),
        sa.Column("triggered_by_user_id", sa.String(), nullable=True),
        sa.Column("triggered_by_username", sa.String(), nullable=True),
        sa.Column("total_features", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("processed_features", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("generated_rows", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("started_at", sa.Float(), nullable=True),
        sa.Column("finished_at", sa.Float(), nullable=True),
        sa.Column("updated_at", sa.Float(), nullable=False, server_default="0"),
        sa.Column("error_message", sa.String(), nullable=True),
    )

    op.create_table(
        "feature_combinations",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column("feature_id", sa.String(), nullable=False, index=True),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("unit", sa.String(), nullable=True),
        sa.Column("normalized_values_key", sa.String(), nullable=False),
        sa.Column("normalized_values_json", sa.JSON(), nullable=False),
        sa.Column("item_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("built_at", sa.Float(), nullable=True),
    )
    op.create_index(
        "ix_feature_combinations_feature_key",
        "feature_combinations",
        ["feature_id", "normalized_values_key"],
    )


def downgrade() -> None:
    op.drop_index("ix_feature_combinations_feature_key", table_name="feature_combinations")
    op.drop_table("feature_combinations")
    op.drop_table("feature_combination_jobs")
