"""fix revision ids to be under 32 chars

Revision ID: 0005_fix_revision_ids
Revises: 0004_add_local_mappings
Create Date: 2026-02-22 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0005_fix_revision_ids"
down_revision = "0004_add_local_mappings"
branch_labels = None
depends_on = None


def upgrade():
    # Fix any old long revision IDs in the database
    conn = op.get_bind()
    try:
        conn.execute(sa.text(
            "UPDATE alembic_version SET version_num = '0004_add_local_mappings' "
            "WHERE version_num = '0004_add_local_attribute_mappings'"
        ))
    except Exception:
        pass


def downgrade():
    pass
