"""add mapped_from column to workspace_mappings

Revision ID: 0009_add_workspace_mapping_mapped_from
Revises: 0008_add_workspace_mapping_attribute_type
Create Date: 2026-04-02 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0009_add_workspace_mapping_mapped_from"
down_revision = "0008_add_workspace_mapping_attribute_type"
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if "workspace_mappings" in inspector.get_table_names():
        existing_cols = [c["name"] for c in inspector.get_columns("workspace_mappings")]
        if "mapped_from" not in existing_cols:
            op.add_column(
                "workspace_mappings",
                sa.Column("mapped_from", sa.String(), nullable=False, server_default="global"),
            )


def downgrade():
    op.drop_column("workspace_mappings", "mapped_from")
