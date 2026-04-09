"""Add classification and ml_predictions columns to bom_items

Revision ID: 0017
Revises: 0016_add_user_approval_status
Create Date: 2026-04-07

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "0017_add_classification_and_ml_predictions"
down_revision = "0016_add_user_approval_status"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bom_items", sa.Column("classification", sa.String(), nullable=True))
    op.add_column("bom_items", sa.Column("ml_predictions", sa.JSON(), nullable=True))
    op.create_index("ix_bom_items_classification", "bom_items", ["classification"])

    # Migrate existing itemClassifications from AppState JSON into the new column
    conn = op.get_bind()
    row = conn.execute(sa.text("SELECT state FROM app_state WHERE id = 1")).fetchone()
    if row and row[0]:
        import json
        state = row[0] if isinstance(row[0], dict) else json.loads(row[0])
        item_classifications = state.get("itemClassifications") or {}
        for item_id, class_id in item_classifications.items():
            if class_id and class_id != "UNCLASSIFIED":
                conn.execute(
                    sa.text("UPDATE bom_items SET classification = :class_id WHERE item_id = :item_id"),
                    {"class_id": class_id, "item_id": item_id},
                )


def downgrade() -> None:
    op.drop_index("ix_bom_items_classification", table_name="bom_items")
    op.drop_column("bom_items", "ml_predictions")
    op.drop_column("bom_items", "classification")
