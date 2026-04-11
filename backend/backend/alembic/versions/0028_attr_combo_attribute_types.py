"""Add attribute_types columns to attribute_combination tables

Revision ID: 0028_attr_combo_attribute_types
Revises: 0015_add_attribute_combinations
Create Date: 2026-04-11

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0028_attr_combo_attribute_types"
down_revision = "0015_add_attribute_combinations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)

    # attribute_combination_jobs: add selected_attribute_types
    if "attribute_combination_jobs" in inspector.get_table_names():
        cols = [c["name"] for c in inspector.get_columns("attribute_combination_jobs")]
        if "selected_attribute_types" not in cols:
            op.add_column(
                "attribute_combination_jobs",
                sa.Column("selected_attribute_types", sa.JSON, nullable=True),
            )

    # attribute_combinations: add attribute_types_json
    if "attribute_combinations" in inspector.get_table_names():
        cols = [c["name"] for c in inspector.get_columns("attribute_combinations")]
        if "attribute_types_json" not in cols:
            op.add_column(
                "attribute_combinations",
                sa.Column("attribute_types_json", sa.JSON, nullable=True),
            )


def downgrade() -> None:
    op.drop_column("attribute_combinations", "attribute_types_json")
    op.drop_column("attribute_combination_jobs", "selected_attribute_types")
