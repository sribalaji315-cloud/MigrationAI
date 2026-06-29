"""Add comments column to group_features and flip empty-target in_progress rows to review

Revision ID: 0047_add_group_feature_comments
Revises: 0046_add_api_keys
Create Date: 2026-06-29

"""
from alembic import op
import sqlalchemy as sa


revision = "0047_add_group_feature_comments"
down_revision = "0046_add_api_keys"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    cols = [c["name"] for c in inspector.get_columns("group_features")]
    if "comments" not in cols:
        op.add_column("group_features", sa.Column("comments", sa.String(), nullable=True))

    # One-time backfill: rows with no target attribute that are still in_progress
    # become "review" and are tagged with a comment.
    op.execute(
        """
        UPDATE group_features
        SET value_status = 'review',
            comments = 'pause-discontinued items'
        WHERE value_status = 'in_progress'
          AND (target_attribute IS NULL OR target_attribute = '')
        """
    )


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    cols = [c["name"] for c in inspector.get_columns("group_features")]
    if "comments" in cols:
        op.drop_column("group_features", "comments")
