"""Add migration approval (item-level flag + per-feature approvals)

Revision ID: 0045_add_migration_approval
Revises: 0044_add_apply_group_feature_jobs
Create Date: 2026-06-25

"""
from alembic import op
import sqlalchemy as sa


revision = "0045_add_migration_approval"
down_revision = "0044_add_apply_group_feature_jobs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "bom_items",
        sa.Column("approved_for_migration", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("bom_items", sa.Column("approved_by_user_id", sa.String(), nullable=True))
    op.add_column("bom_items", sa.Column("approved_by_username", sa.String(), nullable=True))
    op.add_column("bom_items", sa.Column("approved_at", sa.Float(), nullable=True))
    op.create_index(
        "ix_bom_items_approved_for_migration",
        "bom_items",
        ["approved_for_migration"],
    )

    op.create_table(
        "item_feature_approvals",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("item_id", sa.String(), nullable=False, index=True),
        sa.Column("feature_id", sa.String(), nullable=False, index=True),
        sa.Column("approved_by_user_id", sa.String(), nullable=True),
        sa.Column("approved_by_username", sa.String(), nullable=True),
        sa.Column("approved_at", sa.Float(), nullable=True),
        sa.UniqueConstraint("item_id", "feature_id", name="uq_item_feature_approval"),
    )


def downgrade() -> None:
    op.drop_table("item_feature_approvals")
    op.drop_index("ix_bom_items_approved_for_migration", table_name="bom_items")
    op.drop_column("bom_items", "approved_at")
    op.drop_column("bom_items", "approved_by_username")
    op.drop_column("bom_items", "approved_by_user_id")
    op.drop_column("bom_items", "approved_for_migration")
