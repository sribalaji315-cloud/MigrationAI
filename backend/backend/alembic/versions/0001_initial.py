"""initial

Revision ID: 0001_initial
Revises: 
Create Date: 2026-02-20 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '0001_initial'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    # Check if table exists before creating to avoid DuplicateTable errors
    # This can happen if Base.metadata.create_all() was previously used
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = inspector.get_table_names()
    
    if 'users' not in tables:
        op.create_table(
            'users',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('username', sa.String(), nullable=False, unique=True),
            sa.Column('password_hash', sa.String(), nullable=False),
            sa.Column('role', sa.String(), nullable=True),
        )

    if 'app_state' not in tables:
        op.create_table(
            'app_state',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('state', sa.JSON(), nullable=True),
        )


def downgrade():
    op.drop_table('app_state')
    op.drop_table('users')
