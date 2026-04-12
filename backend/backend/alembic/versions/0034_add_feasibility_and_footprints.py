"""Add feasibility column to workspace/merged mappings and footprint columns to manifest entries

Revision ID: 0034_add_feasibility_and_footprints
Revises: 0033_add_valuelist_strategy
Create Date: 2026-04-12

"""
from alembic import op
import sqlalchemy as sa

revision = "0034_add_feasibility_and_footprints"
down_revision = "0033_add_valuelist_strategy"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # --- workspace_mappings: add feasibility ---
    op.add_column(
        "workspace_mappings",
        sa.Column("feasibility", sa.String(), nullable=True),
    )
    # Backfill: "No" when new_value is NOT REQUIRED, else "Yes"
    op.execute(
        "UPDATE workspace_mappings SET feasibility = CASE "
        "WHEN new_value = 'NOT REQUIRED' THEN 'No' ELSE 'Yes' END"
    )

    # --- merged_workspace_mappings: add feasibility ---
    op.add_column(
        "merged_workspace_mappings",
        sa.Column("feasibility", sa.String(), nullable=True),
    )

    # --- migration_manifest_entries: add footprint columns ---
    op.add_column(
        "migration_manifest_entries",
        sa.Column("attribute_footprint", sa.String(), nullable=True),
    )
    op.add_column(
        "migration_manifest_entries",
        sa.Column("value_footprint", sa.String(), nullable=True),
    )
    op.add_column(
        "migration_manifest_entries",
        sa.Column("attribute_footprint_item_count", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "migration_manifest_entries",
        sa.Column("value_footprint_item_count", sa.Integer(), nullable=False, server_default="1"),
    )

    # Indexes for efficient GROUP BY on footprints
    op.create_index(
        "ix_manifest_attr_footprint",
        "migration_manifest_entries",
        ["attribute_footprint"],
    )
    op.create_index(
        "ix_manifest_value_footprint",
        "migration_manifest_entries",
        ["value_footprint"],
    )


def downgrade() -> None:
    op.drop_index("ix_manifest_value_footprint", table_name="migration_manifest_entries")
    op.drop_index("ix_manifest_attr_footprint", table_name="migration_manifest_entries")
    op.drop_column("migration_manifest_entries", "value_footprint_item_count")
    op.drop_column("migration_manifest_entries", "attribute_footprint_item_count")
    op.drop_column("migration_manifest_entries", "value_footprint")
    op.drop_column("migration_manifest_entries", "attribute_footprint")
    op.drop_column("merged_workspace_mappings", "feasibility")
    op.drop_column("workspace_mappings", "feasibility")
