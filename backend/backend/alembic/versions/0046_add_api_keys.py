"""Add api_keys table for external API access

Revision ID: 0046_add_api_keys
Revises: 0045_add_migration_approval
Create Date: 2026-06-25

"""
from alembic import op
import sqlalchemy as sa


revision = "0046_add_api_keys"
down_revision = "0045_add_migration_approval"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if "api_keys" not in inspector.get_table_names():
        op.create_table(
            "api_keys",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("key_hash", sa.String(), nullable=False),
            sa.Column("prefix", sa.String(), nullable=False),
            sa.Column("label", sa.String(), nullable=True),
            sa.Column("created_by", sa.String(), nullable=True),
            sa.Column("created_at", sa.Float(), nullable=False),
            sa.Column("last_used_at", sa.Float(), nullable=True),
            sa.Column("revoked", sa.Integer(), nullable=False, server_default="0"),
        )
        op.create_index("ix_api_keys_key_hash", "api_keys", ["key_hash"], unique=True)


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if "api_keys" in inspector.get_table_names():
        op.drop_index("ix_api_keys_key_hash", table_name="api_keys")
        op.drop_table("api_keys")
