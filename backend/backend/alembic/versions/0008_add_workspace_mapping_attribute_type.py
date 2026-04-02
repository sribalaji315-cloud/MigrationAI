"""add attribute_type column to workspace_mappings

Revision ID: 0008_add_workspace_mapping_attribute_type
Revises: 0007_workspace_mappings_and_generation_jobs
Create Date: 2026-04-01 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0008_add_workspace_mapping_attribute_type"
down_revision = "0007_workspace_mappings_and_generation_jobs"
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if "workspace_mappings" in inspector.get_table_names():
        existing_cols = [c["name"] for c in inspector.get_columns("workspace_mappings")]
        if "attribute_type" not in existing_cols:
            op.add_column(
                "workspace_mappings",
                sa.Column("attribute_type", sa.String(), nullable=False, server_default=""),
            )


def downgrade():
    op.drop_column("workspace_mappings", "attribute_type")
