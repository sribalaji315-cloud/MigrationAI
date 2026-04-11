"""Add merged_workspace_mappings table

Revision ID: 0031_add_merged_workspace_mappings
Revises: 0030_add_manifest_acceptance
Create Date: 2026-04-11

"""
from alembic import op
import sqlalchemy as sa

revision = "0031_add_merged_workspace_mappings"
down_revision = "0030_add_manifest_acceptance"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "merged_workspace_mappings",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("legacy_item_id", sa.String(), nullable=False, index=True),
        sa.Column("legacy_feature_id", sa.String(), nullable=False, index=True),
        sa.Column("legacy_value", sa.String(), nullable=False, server_default=""),
        sa.Column("new_attribute_id", sa.String(), nullable=False),
        sa.Column("new_value", sa.String(), nullable=False, server_default=""),
        sa.Column("attribute_type", sa.String(), nullable=False, server_default=""),
        sa.Column("condition", sa.String(), nullable=True),
        sa.Column("formula", sa.String(), nullable=True),
        sa.Column("mapped_from", sa.String(), nullable=False, server_default="manifest"),
        sa.Column("value_status", sa.String(), nullable=True, index=True),
        sa.Column("manifest_entry_id", sa.Integer(), nullable=True, index=True),
        sa.Column("signed_on_by_user_id", sa.String(), nullable=True, index=True),
        sa.Column("signed_on_by_username", sa.String(), nullable=True),
        sa.Column("signed_on_at", sa.Float(), nullable=True),
        sa.Column("updated_at", sa.Float(), nullable=False, server_default="0"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_by", sa.String(), nullable=True),
        sa.Column("modified_by", sa.String(), nullable=True),
        sa.Column("modified_at", sa.Float(), nullable=True),
        sa.UniqueConstraint(
            "legacy_item_id",
            "legacy_feature_id",
            "legacy_value",
            name="uq_merged_ws_mappings_item_feature_value",
        ),
    )
    op.create_index(
        "ix_merged_ws_mappings_item_feature",
        "merged_workspace_mappings",
        ["legacy_item_id", "legacy_feature_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_merged_ws_mappings_item_feature", table_name="merged_workspace_mappings")
    op.drop_table("merged_workspace_mappings")
