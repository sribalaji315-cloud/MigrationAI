"""Add merge_jobs table and footprint columns to merged_workspace_mappings

Revision ID: 0035_add_merge_job_and_merged_footprints
Revises: 0034_add_feasibility_and_footprints
Create Date: 2026-04-12

"""
from alembic import op
import sqlalchemy as sa

revision = "0035_add_merge_job_and_merged_footprints"
down_revision = "0034_add_feasibility_and_footprints"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # --- merged_workspace_mappings: add footprint columns ---
    op.add_column(
        "merged_workspace_mappings",
        sa.Column("attribute_footprint", sa.String(), nullable=True),
    )
    op.add_column(
        "merged_workspace_mappings",
        sa.Column("value_footprint", sa.String(), nullable=True),
    )
    op.create_index(
        "ix_merged_ws_attr_footprint",
        "merged_workspace_mappings",
        ["attribute_footprint"],
    )
    op.create_index(
        "ix_merged_ws_value_footprint",
        "merged_workspace_mappings",
        ["value_footprint"],
    )

    # --- merge_jobs table ---
    op.create_table(
        "merge_jobs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("status", sa.String(), nullable=False, index=True),
        sa.Column("triggered_by_username", sa.String(), nullable=True),
        sa.Column("total_items", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("processed_items", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("generated_rows", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("started_at", sa.Float(), nullable=True),
        sa.Column("finished_at", sa.Float(), nullable=True),
        sa.Column("updated_at", sa.Float(), nullable=False, server_default="0"),
        sa.Column("error_message", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("merge_jobs")
    op.drop_index("ix_merged_ws_value_footprint", table_name="merged_workspace_mappings")
    op.drop_index("ix_merged_ws_attr_footprint", table_name="merged_workspace_mappings")
    op.drop_column("merged_workspace_mappings", "value_footprint")
    op.drop_column("merged_workspace_mappings", "attribute_footprint")
