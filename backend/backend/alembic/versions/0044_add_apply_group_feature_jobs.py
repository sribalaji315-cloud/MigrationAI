"""Add apply_group_feature_jobs table

Revision ID: 0044_add_apply_group_feature_jobs
Revises: 0043_add_group_feature_suggestions
Create Date: 2026-06-25

"""
from alembic import op
import sqlalchemy as sa

revision = "0044_add_apply_group_feature_jobs"
down_revision = "0043_add_group_feature_suggestions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "apply_group_feature_jobs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
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


def downgrade() -> None:
    op.drop_table("apply_group_feature_jobs")
