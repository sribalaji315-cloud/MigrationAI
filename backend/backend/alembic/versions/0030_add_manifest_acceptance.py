"""Add acceptance fields to migration manifest entries

Revision ID: 0030_add_manifest_acceptance
Revises: 0029_add_migration_manifest
Create Date: 2026-04-11

"""
from alembic import op
import sqlalchemy as sa

revision = "0030_add_manifest_acceptance"
down_revision = "0029_add_migration_manifest"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("migration_manifest_entries", sa.Column("is_accepted", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("migration_manifest_entries", sa.Column("accepted_at", sa.Float(), nullable=True))
    op.add_column("migration_manifest_entries", sa.Column("accepted_by_username", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("migration_manifest_entries", "accepted_by_username")
    op.drop_column("migration_manifest_entries", "accepted_at")
    op.drop_column("migration_manifest_entries", "is_accepted")