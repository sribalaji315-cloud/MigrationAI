"""Add item_class_attribute_values table

Revision ID: 0018_add_item_class_attribute_values
Revises: 0017_add_classification_and_ml_predictions
Create Date: 2026-04-08

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0018_add_item_class_attribute_values"
down_revision = "0017_add_classification_and_ml_predictions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "item_class_attribute_values",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("item_id", sa.String(), nullable=False, index=True),
        sa.Column("class_id", sa.String(), nullable=False, index=True),
        sa.Column("attribute_id", sa.String(), nullable=False),
        sa.Column("value", sa.String(), nullable=False, server_default=""),
        sa.UniqueConstraint("item_id", "class_id", "attribute_id", name="uq_item_class_attr_val"),
    )

    # Migrate existing classAttributeValues from app_state JSON blob
    conn = op.get_bind()
    row = conn.execute(sa.text("SELECT state FROM app_state WHERE id = 1")).fetchone()
    if row and row[0]:
        import json
        state = row[0] if isinstance(row[0], dict) else json.loads(row[0])
        class_attr_values = state.get("classAttributeValues") or {}
        item_classifications = state.get("itemClassifications") or {}
        for item_id, attr_dict in class_attr_values.items():
            if not isinstance(attr_dict, dict):
                continue
            class_id = item_classifications.get(item_id)
            if not class_id or class_id == "UNCLASSIFIED":
                continue
            for attr_id, value in attr_dict.items():
                if value and str(value).strip():
                    conn.execute(
                        sa.text(
                            "INSERT INTO item_class_attribute_values (item_id, class_id, attribute_id, value) "
                            "VALUES (:item_id, :class_id, :attr_id, :value)"
                        ),
                        {"item_id": item_id, "class_id": class_id, "attr_id": attr_id, "value": str(value).strip()},
                    )


def downgrade() -> None:
    op.drop_table("item_class_attribute_values")
