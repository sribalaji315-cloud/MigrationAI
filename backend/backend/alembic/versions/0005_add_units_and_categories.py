"""add units and category/product type fields

Revision ID: 0005_add_units_and_categories
Revises: 0004_add_local_mappings
Create Date: 2026-02-26 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0005_add_units_and_categories"
down_revision = "0004_add_local_mappings"
branch_labels = None
depends_on = None


def _has_column(inspector, table_name: str, column_name: str) -> bool:
    return column_name in [col["name"] for col in inspector.get_columns(table_name)]


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = inspector.get_table_names()

    if "bom_items" in tables:
        if not _has_column(inspector, "bom_items", "category"):
            op.add_column("bom_items", sa.Column("category", sa.String(), nullable=True))
            op.create_index("ix_bom_items_category", "bom_items", ["category"])
        if not _has_column(inspector, "bom_items", "product_type"):
            op.add_column("bom_items", sa.Column("product_type", sa.String(), nullable=True))
            op.create_index("ix_bom_items_product_type", "bom_items", ["product_type"])

    if "bom_features" in tables:
        if not _has_column(inspector, "bom_features", "unit"):
            op.add_column("bom_features", sa.Column("unit", sa.String(), nullable=True))

    if "local_attribute_mappings" in tables:
        if not _has_column(inspector, "local_attribute_mappings", "category"):
            op.add_column("local_attribute_mappings", sa.Column("category", sa.String(), nullable=True))
            op.create_index("ix_local_attribute_mappings_category", "local_attribute_mappings", ["category"])
        if not _has_column(inspector, "local_attribute_mappings", "product_type"):
            op.add_column("local_attribute_mappings", sa.Column("product_type", sa.String(), nullable=True))
            op.create_index("ix_local_attribute_mappings_product_type", "local_attribute_mappings", ["product_type"])


def downgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = inspector.get_table_names()

    if "local_attribute_mappings" in tables:
        if _has_column(inspector, "local_attribute_mappings", "product_type"):
            op.drop_index("ix_local_attribute_mappings_product_type", table_name="local_attribute_mappings")
            op.drop_column("local_attribute_mappings", "product_type")
        if _has_column(inspector, "local_attribute_mappings", "category"):
            op.drop_index("ix_local_attribute_mappings_category", table_name="local_attribute_mappings")
            op.drop_column("local_attribute_mappings", "category")

    if "bom_features" in tables:
        if _has_column(inspector, "bom_features", "unit"):
            op.drop_column("bom_features", "unit")

    if "bom_items" in tables:
        if _has_column(inspector, "bom_items", "product_type"):
            op.drop_index("ix_bom_items_product_type", table_name="bom_items")
            op.drop_column("bom_items", "product_type")
        if _has_column(inspector, "bom_items", "category"):
            op.drop_index("ix_bom_items_category", table_name="bom_items")
            op.drop_column("bom_items", "category")
