"""Add version and audit columns to mapping tables

Revision ID: 0012
Revises: 0011
Create Date: 2025-01-01 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers
revision = '0012_add_version_and_audit_columns'
down_revision = '0011_add_item_locks_token_blacklist_audit'
branch_labels = None
depends_on = None


def upgrade():
    # Phase 4.2: Version columns for optimistic locking / conflict detection
    op.add_column('global_mappings', sa.Column('version', sa.Integer(), nullable=False, server_default='1'))
    op.add_column('workspace_mappings', sa.Column('version', sa.Integer(), nullable=False, server_default='1'))

    # Phase 4.3: Audit trail columns
    op.add_column('global_mappings', sa.Column('created_by', sa.String(), nullable=True))
    op.add_column('global_mappings', sa.Column('modified_by', sa.String(), nullable=True))
    op.add_column('global_mappings', sa.Column('modified_at', sa.Float(), nullable=True))

    op.add_column('workspace_mappings', sa.Column('created_by', sa.String(), nullable=True))
    op.add_column('workspace_mappings', sa.Column('modified_by', sa.String(), nullable=True))
    op.add_column('workspace_mappings', sa.Column('modified_at', sa.Float(), nullable=True))


def downgrade():
    op.drop_column('workspace_mappings', 'modified_at')
    op.drop_column('workspace_mappings', 'modified_by')
    op.drop_column('workspace_mappings', 'created_by')
    op.drop_column('workspace_mappings', 'version')

    op.drop_column('global_mappings', 'modified_at')
    op.drop_column('global_mappings', 'modified_by')
    op.drop_column('global_mappings', 'created_by')
    op.drop_column('global_mappings', 'version')
