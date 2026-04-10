"""Add status + ignored_values to global_mappings, value_status to workspace_mappings

Revision ID: 0027_value_status_and_global_ignore
Revises: 0026_consolidation_plan_status_details
Create Date: 2026-04-10
"""

from alembic import op
import sqlalchemy as sa

revision = "0027_value_status_and_global_ignore"
down_revision = "0026_consolidation_plan_status_details"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("global_mappings") as batch_op:
        batch_op.add_column(sa.Column("status", sa.String(), nullable=False, server_default="active"))
        batch_op.add_column(sa.Column("ignored_values", sa.JSON(), nullable=True))

    with op.batch_alter_table("workspace_mappings") as batch_op:
        batch_op.add_column(sa.Column("value_status", sa.String(), nullable=True))
        batch_op.create_index("ix_workspace_mappings_value_status", ["value_status"])


def downgrade() -> None:
    with op.batch_alter_table("workspace_mappings") as batch_op:
        batch_op.drop_index("ix_workspace_mappings_value_status")
        batch_op.drop_column("value_status")

    with op.batch_alter_table("global_mappings") as batch_op:
        batch_op.drop_column("ignored_values")
        batch_op.drop_column("status")
