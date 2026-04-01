"""add attribute_type to global_mappings

Revision ID: 0006_add_global_mapping_attribute_type
Revises: 0005_add_units_and_categories
Create Date: 2026-04-01 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0006_add_global_mapping_attribute_type"
down_revision = "0005_add_units_and_categories"
branch_labels = None
depends_on = None


def _has_column(inspector, table_name: str, column_name: str) -> bool:
    return column_name in [col["name"] for col in inspector.get_columns(table_name)]


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = inspector.get_table_names()

    if "global_mappings" in tables:
        if not _has_column(inspector, "global_mappings", "attribute_type"):
            op.add_column(
                "global_mappings",
                sa.Column("attribute_type", sa.String(), nullable=True),
            )

        op.execute("UPDATE global_mappings SET attribute_type = '' WHERE attribute_type IS NULL")

        # SQLite doesn't support ALTER COLUMN SET NOT NULL / DROP DEFAULT syntax.
        if conn.dialect.name != "sqlite":
            op.alter_column("global_mappings", "attribute_type", nullable=False, server_default=None)


def downgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = inspector.get_table_names()

    if "global_mappings" in tables and _has_column(inspector, "global_mappings", "attribute_type"):
        op.drop_column("global_mappings", "attribute_type")
