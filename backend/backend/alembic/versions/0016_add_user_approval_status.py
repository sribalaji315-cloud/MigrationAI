"""Add user approval status

Revision ID: 0016
Revises: 0015_add_parent_bom_to_hierarchy
Create Date: 2026-04-07

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0016_add_user_approval_status"
down_revision = "0015_add_parent_bom_to_hierarchy"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("approval_status", sa.String(), server_default="approved", nullable=False))


def downgrade() -> None:
    op.drop_column("users", "approval_status")
