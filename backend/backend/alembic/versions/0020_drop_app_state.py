"""Drop app_state table — all data now lives in dedicated tables

Revision ID: 0020_drop_app_state
Revises: 0019_add_app_config
Create Date: 2026-04-08

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0020_drop_app_state"
down_revision = "0019_add_app_config"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("app_state")


def downgrade() -> None:
    op.create_table(
        "app_state",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("state", sa.JSON(), nullable=True),
    )
