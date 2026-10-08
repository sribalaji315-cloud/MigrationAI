"""Add covering indexes on workspace_mappings for the Where Used page

Revision ID: 0049_add_where_used_indexes
Revises: 0048_add_conversion_to_bom_hierarchy
Create Date: 2026-10-08

"""
from alembic import op
import sqlalchemy as sa


revision = "0049_add_where_used_indexes"
down_revision = "0048_add_conversion_to_bom_hierarchy"
branch_labels = None
depends_on = None


# Wide covering indexes so the Where Used GROUP BYs run as index-only scans in
# group order. Measured on a 2.5M-row table: the target-attribute aggregate
# drops from 18.4s (table scan + sort) to 1.6s. Costs ~140MB per index.
_INDEXES = [
    (
        "ix_wu_target",
        ["new_attribute_id", "new_value", "legacy_item_id", "legacy_feature_id", "legacy_value"],
    ),
    (
        "ix_wu_legacy",
        ["legacy_feature_id", "legacy_value", "legacy_item_id", "new_attribute_id", "new_value"],
    ),
]


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if "workspace_mappings" not in inspector.get_table_names():
        return
    existing = {ix["name"] for ix in inspector.get_indexes("workspace_mappings")}
    for name, cols in _INDEXES:
        if name not in existing:
            op.create_index(name, "workspace_mappings", cols)


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if "workspace_mappings" not in inspector.get_table_names():
        return
    existing = {ix["name"] for ix in inspector.get_indexes("workspace_mappings")}
    for name, _cols in reversed(_INDEXES):
        if name in existing:
            op.drop_index(name, table_name="workspace_mappings")
