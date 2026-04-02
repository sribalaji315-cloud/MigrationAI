"""add item_locks, token_blacklist, audit_log tables

Revision ID: 0011_add_item_locks_token_blacklist_audit
Revises: 0010_add_value_list
Create Date: 2026-04-02 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = "0011_add_item_locks_token_blacklist_audit"
down_revision = "0010_add_value_list"
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing = inspector.get_table_names()

    if "item_locks" not in existing:
        op.create_table(
            "item_locks",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("item_id", sa.String(), nullable=False),
            sa.Column("user_id", sa.String(), nullable=False),
            sa.Column("user_name", sa.String(), nullable=True),
            sa.Column("acquired_at", sa.Float(), nullable=False),
        )
        op.create_index("ix_item_locks_item_id", "item_locks", ["item_id"], unique=True)
        op.create_index("ix_item_locks_user_id", "item_locks", ["user_id"])

    if "token_blacklist" not in existing:
        op.create_table(
            "token_blacklist",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("jti", sa.String(), nullable=False),
            sa.Column("expires_at", sa.Float(), nullable=False),
        )
        op.create_index("ix_token_blacklist_jti", "token_blacklist", ["jti"], unique=True)

    if "audit_log" not in existing:
        op.create_table(
            "audit_log",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("timestamp", sa.Float(), nullable=False),
            sa.Column("user_id", sa.String(), nullable=True),
            sa.Column("username", sa.String(), nullable=True),
            sa.Column("action", sa.String(), nullable=False),
            sa.Column("detail", sa.String(), nullable=True),
        )

    # Phase 3.3: Add missing database indexes
    bom_feature_indexes = {idx["name"] for idx in inspector.get_indexes("bom_features")} if "bom_features" in existing else set()
    if "ix_bom_features_feature_id" not in bom_feature_indexes:
        op.create_index("ix_bom_features_feature_id", "bom_features", ["feature_id"])

    bom_item_indexes = {idx["name"] for idx in inspector.get_indexes("bom_items")} if "bom_items" in existing else set()
    if "ix_bom_items_category_product_type" not in bom_item_indexes:
        op.create_index("ix_bom_items_category_product_type", "bom_items", ["category", "product_type"])


def downgrade():
    op.drop_table("audit_log")
    op.drop_table("token_blacklist")
    op.drop_table("item_locks")
    op.drop_index("ix_bom_features_feature_id", table_name="bom_features")
    op.drop_index("ix_bom_items_category_product_type", table_name="bom_items")
