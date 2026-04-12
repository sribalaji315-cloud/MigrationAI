"""Add valuelist strategy tables and alter merged_workspace_mappings

Revision ID: 0033_add_valuelist_strategy
Revises: 0032_add_manifest_combo_item_count
Create Date: 2026-04-12

"""
from alembic import op
import sqlalchemy as sa

revision = "0033_add_valuelist_strategy"
down_revision = "0032_add_manifest_combo_item_count"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create valuelist_strategy_jobs table
    op.create_table(
        "valuelist_strategy_jobs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("status", sa.String(), nullable=False, index=True),  # queued|running|completed|failed
        sa.Column("strategy", sa.String(), nullable=False, server_default="conservative"),  # conservative|aggressive
        sa.Column("total_attributes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("fixed_only_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("valuelist_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("unique_valuelists", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("merged_valuelists", sa.Integer(), nullable=True),
        sa.Column("error_message", sa.String(), nullable=True),
        sa.Column("created_at", sa.Float(), nullable=True),
        sa.Column("completed_at", sa.Float(), nullable=True),
    )

    # Create target_attribute_profiles table
    op.create_table(
        "target_attribute_profiles",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("target_attribute_id", sa.String(), nullable=False, unique=True, index=True),
        sa.Column("classification", sa.String(), nullable=False),  # fixed_only|valuelist
        sa.Column("valuelist_id", sa.String(), nullable=True, index=True),
        sa.Column("total_items", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("fixed_value_items", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("multi_value_items", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("canonical_values_json", sa.JSON(), nullable=True),
        sa.Column("noise_values_json", sa.JSON(), nullable=True),
        sa.Column("dedup_group_key", sa.String(), nullable=True, index=True),
        sa.Column("job_id", sa.Integer(), nullable=True, index=True),
        sa.Column("created_at", sa.Float(), nullable=True),
        sa.Column("updated_at", sa.Float(), nullable=True),
    )

    # Add valuelist_id and is_effective_fixed to merged_workspace_mappings
    op.add_column(
        "merged_workspace_mappings",
        sa.Column("valuelist_id", sa.String(), nullable=True, index=True),
    )
    op.add_column(
        "merged_workspace_mappings",
        sa.Column("is_effective_fixed", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index(
        "ix_merged_ws_mappings_valuelist_id",
        "merged_workspace_mappings",
        ["valuelist_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_merged_ws_mappings_valuelist_id", table_name="merged_workspace_mappings")
    op.drop_column("merged_workspace_mappings", "is_effective_fixed")
    op.drop_column("merged_workspace_mappings", "valuelist_id")
    op.drop_table("target_attribute_profiles")
    op.drop_table("valuelist_strategy_jobs")
