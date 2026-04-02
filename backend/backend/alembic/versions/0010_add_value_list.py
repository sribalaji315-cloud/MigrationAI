"""add value_list table

Revision ID: 0010_add_value_list
Revises: 0009_add_workspace_mapping_mapped_from
Create Date: 2026-04-02 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0010_add_value_list"
down_revision = "0009_add_workspace_mapping_mapped_from"
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if "value_list" not in inspector.get_table_names():
        op.create_table(
            "value_list",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("valuelist_id", sa.String(), nullable=False),
            sa.Column("valuelist_id_description", sa.String(), nullable=True),
            sa.Column("unit", sa.String(), nullable=True),
            sa.Column("value", sa.String(), nullable=False),
            sa.Column("value_description", sa.String(), nullable=True),
        )
    existing_indexes = {idx["name"] for idx in inspector.get_indexes("value_list")}
    if "ix_value_list_valuelist_id" not in existing_indexes:
        op.create_index("ix_value_list_valuelist_id", "value_list", ["valuelist_id"])


def downgrade():
    op.drop_table("value_list")
