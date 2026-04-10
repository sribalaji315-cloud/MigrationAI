"""Add status, details_json, error_message to consolidation_plans

Revision ID: 0026_consolidation_plan_status_details
Revises: 0025_add_consolidation_plans
Create Date: 2026-04-09
"""

from alembic import op
import sqlalchemy as sa

revision = "0026_consolidation_plan_status_details"
down_revision = "0025_add_consolidation_plans"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("consolidation_plans") as batch_op:
        batch_op.add_column(sa.Column("status", sa.String(), nullable=False, server_default="completed"))
        batch_op.add_column(sa.Column("details_json", sa.JSON(), nullable=True))
        batch_op.add_column(sa.Column("error_message", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("consolidation_plans") as batch_op:
        batch_op.drop_column("error_message")
        batch_op.drop_column("details_json")
        batch_op.drop_column("status")
