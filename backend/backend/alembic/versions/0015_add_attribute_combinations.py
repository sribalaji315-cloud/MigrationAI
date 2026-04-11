"""Add attribute_combination_jobs and attribute_combinations tables

Revision ID: 0015_add_attribute_combinations
Revises: 0027_value_status_and_global_ignore
Create Date: 2026-04-11

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0015_add_attribute_combinations"
down_revision = "0027_value_status_and_global_ignore"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = inspector.get_table_names()

    if "attribute_combination_jobs" not in tables:
        op.create_table(
            "attribute_combination_jobs",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("triggered_by_user_id", sa.String(), nullable=True),
            sa.Column("triggered_by_username", sa.String(), nullable=True),
            sa.Column("total_items", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("processed_items", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("generated_rows", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("started_at", sa.Float(), nullable=True),
            sa.Column("finished_at", sa.Float(), nullable=True),
            sa.Column("updated_at", sa.Float(), nullable=False, server_default="0"),
            sa.Column("error_message", sa.String(), nullable=True),
        )
        op.create_index("ix_attribute_combination_jobs_status", "attribute_combination_jobs", ["status"])

    if "attribute_combinations" not in tables:
        op.create_table(
            "attribute_combinations",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("feature_ids_key", sa.String(), nullable=False),
            sa.Column("feature_ids_json", sa.JSON(), nullable=False),
            sa.Column("feature_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("item_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("item_ids_json", sa.JSON(), nullable=True),
            sa.Column("priorities_json", sa.JSON(), nullable=True),
            sa.Column("categories_json", sa.JSON(), nullable=True),
            sa.Column("product_types_json", sa.JSON(), nullable=True),
            sa.Column("built_at", sa.Float(), nullable=True),
        )
        op.create_index("ix_attribute_combinations_feature_ids_key", "attribute_combinations", ["feature_ids_key"])
        op.create_index("ix_attribute_combinations_feature_count", "attribute_combinations", ["feature_count"])
        op.create_index("ix_attribute_combinations_item_count", "attribute_combinations", ["item_count"])


def downgrade() -> None:
    op.drop_table("attribute_combinations")
    op.drop_table("attribute_combination_jobs")
