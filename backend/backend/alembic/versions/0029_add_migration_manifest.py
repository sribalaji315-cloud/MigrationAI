"""Add migration manifest tables

Revision ID: 0029_add_migration_manifest
Revises: 0028_attr_combo_attribute_types
Create Date: 2026-04-11

"""
from alembic import op
import sqlalchemy as sa

revision = "0029_add_migration_manifest"
down_revision = "0028_attr_combo_attribute_types"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "migration_manifest_jobs",
        sa.Column("id", sa.Integer, primary_key=True, index=True),
        sa.Column("status", sa.String, index=True, nullable=False),
        sa.Column("triggered_by_username", sa.String, nullable=True),
        sa.Column("total_items", sa.Integer, nullable=False, server_default="0"),
        sa.Column("processed_items", sa.Integer, nullable=False, server_default="0"),
        sa.Column("generated_rows", sa.Integer, nullable=False, server_default="0"),
        sa.Column("started_at", sa.Float, nullable=True),
        sa.Column("finished_at", sa.Float, nullable=True),
        sa.Column("updated_at", sa.Float, nullable=False, server_default="0"),
        sa.Column("error_message", sa.String, nullable=True),
    )

    op.create_table(
        "migration_manifest_entries",
        sa.Column("id", sa.Integer, primary_key=True, index=True),
        sa.Column("item_id", sa.String, nullable=False),
        sa.Column("item_description", sa.String, nullable=True),
        sa.Column("item_category", sa.String, nullable=True),
        sa.Column("item_product_type", sa.String, nullable=True),
        sa.Column("item_priority", sa.Integer, nullable=True),
        sa.Column("legacy_feature_id", sa.String, nullable=False),
        sa.Column("target_attribute_id", sa.String, nullable=True),
        sa.Column("attribute_type", sa.String, nullable=True),
        sa.Column("source", sa.String, nullable=False, server_default="original"),
        sa.Column("is_noise", sa.Integer, nullable=False, server_default="0"),
        sa.Column("noise_type", sa.String, nullable=True),
        sa.Column("original_values_json", sa.JSON, nullable=True),
        sa.Column("target_values_json", sa.JSON, nullable=True),
        sa.Column("noise_values_json", sa.JSON, nullable=True),
        sa.Column("has_mapping", sa.Integer, nullable=False, server_default="0"),
        sa.Column("built_at", sa.Float, nullable=True),
    )

    op.create_index("ix_manifest_item", "migration_manifest_entries", ["item_id"])
    op.create_index("ix_manifest_feature", "migration_manifest_entries", ["legacy_feature_id"])
    op.create_index("ix_manifest_target", "migration_manifest_entries", ["target_attribute_id"])


def downgrade() -> None:
    op.drop_table("migration_manifest_entries")
    op.drop_table("migration_manifest_jobs")
