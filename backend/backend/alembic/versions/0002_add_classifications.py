"""add classifications table

Revision ID: 0002_add_classifications
Revises: 0001_initial
Create Date: 2026-02-21 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '0002_add_classifications'
down_revision = '0001_initial'
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = inspector.get_table_names()
    
    if 'classifications' not in tables:
        op.create_table(
            'classifications',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('class_id', sa.String(), nullable=False, unique=True),
            sa.Column('class_name', sa.String(), nullable=False),
            sa.Column('attributes', sa.JSON(), nullable=True),
        )


def downgrade():
    op.drop_table('classifications')
