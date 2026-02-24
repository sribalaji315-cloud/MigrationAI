"""add local attribute mappings table

Revision ID: 0004_add_local_mappings
Revises: 0003_add_bom_and_mappings
Create Date: 2026-02-22 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0004_add_local_mappings"
down_revision = "0003_add_bom_and_mappings"
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = inspector.get_table_names()

    # Ensure alembic_version.version_num column is wide enough for revision IDs
    # Postgres creates this as VARCHAR(32) by default; increase it to avoid
    # StringDataRightTruncation when storing longer revision identifiers.
    try:
        if conn.dialect.name == "postgresql":
            conn.execute(sa.text("ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(255)"))
    except Exception:
        # Best-effort only; ignore if the table/column does not exist or dialect differs.
        pass

    if "local_attribute_mappings" not in tables:
        op.create_table(
            "local_attribute_mappings",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("item_id", sa.String(), nullable=False, index=True),
            sa.Column("item_description", sa.String(), nullable=True),
            sa.Column("legacy_attribute_id", sa.String(), nullable=False, index=True),
            sa.Column("legacy_value", sa.String(), nullable=False),
            sa.Column("new_attribute_id", sa.String(), nullable=False),
            sa.Column("new_value", sa.String(), nullable=False),
        )


def downgrade():
    op.drop_table("local_attribute_mappings")
