"""add workspace mappings and generation jobs

Revision ID: 0007_workspace_mappings_and_generation_jobs
Revises: 0006_add_global_mapping_attribute_type
Create Date: 2026-04-01 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
import time

# revision identifiers, used by Alembic.
revision = "0007_workspace_mappings_and_generation_jobs"
down_revision = "0006_add_global_mapping_attribute_type"
branch_labels = None
depends_on = None


def _table_exists(inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = inspector.get_table_names()

    if "workspace_mappings" not in tables:
        op.create_table(
            "workspace_mappings",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("legacy_item_id", sa.String(), nullable=False),
            sa.Column("legacy_feature_id", sa.String(), nullable=False),
            sa.Column("legacy_value", sa.String(), nullable=False, server_default=""),
            sa.Column("new_attribute_id", sa.String(), nullable=False),
            sa.Column("new_value", sa.String(), nullable=False, server_default=""),
            sa.Column("signed_on_by_user_id", sa.String(), nullable=True),
            sa.Column("signed_on_by_username", sa.String(), nullable=True),
            sa.Column("signed_on_at", sa.Float(), nullable=True),
            sa.Column("updated_at", sa.Float(), nullable=False, server_default="0"),
            sa.UniqueConstraint(
                "legacy_item_id",
                "legacy_feature_id",
                "legacy_value",
                name="uq_workspace_mappings_item_feature_value",
            ),
        )
        op.create_index("ix_workspace_mappings_legacy_item_id", "workspace_mappings", ["legacy_item_id"])
        op.create_index("ix_workspace_mappings_legacy_feature_id", "workspace_mappings", ["legacy_feature_id"])
        op.create_index("ix_workspace_mappings_signed_on_by_user_id", "workspace_mappings", ["signed_on_by_user_id"])
        op.create_index("ix_workspace_mappings_item_feature", "workspace_mappings", ["legacy_item_id", "legacy_feature_id"])

    if "mapping_generation_jobs" not in tables:
        op.create_table(
            "mapping_generation_jobs",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("triggered_by_user_id", sa.String(), nullable=True),
            sa.Column("triggered_by_username", sa.String(), nullable=True),
            sa.Column("trigger_source", sa.String(), nullable=True),
            sa.Column("total_features", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("processed_features", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("total_values", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("processed_values", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("generated_rows", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("started_at", sa.Float(), nullable=True),
            sa.Column("finished_at", sa.Float(), nullable=True),
            sa.Column("updated_at", sa.Float(), nullable=False, server_default="0"),
            sa.Column("error_message", sa.String(), nullable=True),
        )
        op.create_index("ix_mapping_generation_jobs_status", "mapping_generation_jobs", ["status"])
        op.create_index("ix_mapping_generation_jobs_triggered_by_user_id", "mapping_generation_jobs", ["triggered_by_user_id"])
        op.create_index("ix_mapping_generation_jobs_updated_at", "mapping_generation_jobs", ["updated_at"])

    # Backfill from legacy local_attribute_mappings so existing data is visible
    # through the new workspace_mappings source.
    inspector = sa.inspect(conn)
    if _table_exists(inspector, "local_attribute_mappings") and _table_exists(inspector, "workspace_mappings"):
        rows = conn.execute(
            sa.text(
                """
                SELECT item_id, legacy_attribute_id, legacy_value, new_attribute_id, new_value
                FROM local_attribute_mappings
                """
            )
        ).fetchall()

        dedupe = set()
        now_ts = float(time.time())
        for row in rows:
            legacy_item_id = (row[0] or "").strip() if row[0] is not None else ""
            legacy_feature_id = (row[1] or "").strip() if row[1] is not None else ""
            legacy_value = "" if row[2] is None else str(row[2])
            new_attribute_id = "" if row[3] is None else str(row[3])
            new_value = "" if row[4] is None else str(row[4])

            if not legacy_item_id or not legacy_feature_id:
                continue

            key = (legacy_item_id, legacy_feature_id, legacy_value)
            if key in dedupe:
                continue
            dedupe.add(key)

            conn.execute(
                sa.text(
                    """
                    INSERT INTO workspace_mappings (
                        legacy_item_id,
                        legacy_feature_id,
                        legacy_value,
                        new_attribute_id,
                        new_value,
                        signed_on_by_user_id,
                        signed_on_by_username,
                        signed_on_at,
                        updated_at
                    ) VALUES (
                        :legacy_item_id,
                        :legacy_feature_id,
                        :legacy_value,
                        :new_attribute_id,
                        :new_value,
                        NULL,
                        NULL,
                        NULL,
                        :updated_at
                    )
                    """
                ),
                {
                    "legacy_item_id": legacy_item_id,
                    "legacy_feature_id": legacy_feature_id,
                    "legacy_value": legacy_value,
                    "new_attribute_id": new_attribute_id,
                    "new_value": new_value,
                    "updated_at": now_ts,
                },
            )


def downgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = inspector.get_table_names()

    if "mapping_generation_jobs" in tables:
        op.drop_table("mapping_generation_jobs")

    if "workspace_mappings" in tables:
        op.drop_table("workspace_mappings")
