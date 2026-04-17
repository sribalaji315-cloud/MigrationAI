"""Add group_features and group_feature_mapping_jobs tables

Revision ID: 0042_add_group_features
Revises: 0041_add_footprint_valuelist_to_feature_combos
Create Date: 2026-04-16

"""
from alembic import op
import sqlalchemy as sa

revision = "0042_add_group_features"
down_revision = "0041_add_footprint_valuelist_to_feature_combos"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "group_features",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("feature_group", sa.String(), nullable=False, index=True),
        sa.Column("feature_id", sa.String(), nullable=False, index=True),
        sa.Column("feature_desc", sa.String(), nullable=True),
        sa.Column("option", sa.String(), nullable=False, server_default=""),
        sa.Column("option_desc", sa.String(), nullable=True),
        sa.Column("condition", sa.String(), nullable=True),
        sa.Column("till_date", sa.String(), nullable=True),
        sa.Column("target_attribute", sa.String(), nullable=True),
        sa.Column("target_value", sa.String(), nullable=True),
        sa.Column("value_status", sa.String(), nullable=False, server_default="in_progress", index=True),
        sa.Column("valuelist_id", sa.String(), nullable=True, index=True),
        sa.Column("created_by", sa.String(), nullable=True),
        sa.Column("created_at", sa.Float(), nullable=True),
    )

    op.create_table(
        "group_feature_mapping_jobs",
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
    op.drop_table("group_feature_mapping_jobs")
    op.drop_table("group_features")
