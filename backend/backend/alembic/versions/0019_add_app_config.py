"""Add app_config table and migrate mappingTypeConfig from app_state

Revision ID: 0019_add_app_config
Revises: 0018_add_item_class_attribute_values
Create Date: 2026-04-08

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0019_add_app_config"
down_revision = "0018_add_item_class_attribute_values"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "app_config",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("mapping_type_config", sa.JSON(), nullable=True),
    )

    # Migrate mappingTypeConfig from app_state JSON blob to app_config
    conn = op.get_bind()
    row = conn.execute(sa.text("SELECT state FROM app_state WHERE id = 1")).fetchone()
    mapping_type_config = None
    if row and row[0]:
        import json
        state = row[0] if isinstance(row[0], dict) else json.loads(row[0])
        mapping_type_config = state.get("mappingTypeConfig")

    if mapping_type_config:
        import json as json_mod
        conn.execute(
            sa.text("INSERT INTO app_config (id, mapping_type_config) VALUES (1, :mtc)"),
            {"mtc": json_mod.dumps(mapping_type_config)},
        )
    else:
        conn.execute(sa.text("INSERT INTO app_config (id, mapping_type_config) VALUES (1, NULL)"))


def downgrade() -> None:
    op.drop_table("app_config")
