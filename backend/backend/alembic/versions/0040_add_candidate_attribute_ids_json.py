"""Add candidate_attribute_ids_json to workspace and merged workspace mappings

Revision ID: 0040_add_candidate_attribute_ids_json
Revises: 0039_add_footprint_component_lists
Create Date: 2026-04-13

"""
from alembic import op
import sqlalchemy as sa

revision = "0040_add_candidate_attribute_ids_json"
down_revision = "0039_add_footprint_component_lists"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("workspace_mappings") as batch_op:
        batch_op.add_column(sa.Column("candidate_attribute_ids_json", sa.JSON(), nullable=True))

    with op.batch_alter_table("merged_workspace_mappings") as batch_op:
        batch_op.add_column(sa.Column("candidate_attribute_ids_json", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("merged_workspace_mappings") as batch_op:
        batch_op.drop_column("candidate_attribute_ids_json")

    with op.batch_alter_table("workspace_mappings") as batch_op:
        batch_op.drop_column("candidate_attribute_ids_json")
