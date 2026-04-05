from sqlalchemy import Column, Integer, JSON, String, ForeignKey, Float, UniqueConstraint, Index
from sqlalchemy.orm import relationship
from .session import Base


class AppState(Base):
    __tablename__ = "app_state"
    id = Column(Integer, primary_key=True, index=True)
    state = Column(JSON, nullable=True)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role = Column(String, default="user")


class Classification(Base):
    __tablename__ = "classifications"
    id = Column(Integer, primary_key=True, index=True)
    class_id = Column(String, unique=True, index=True, nullable=False)
    class_name = Column(String, nullable=False)
    # attributes is a list of objects describing each attribute; stored as JSON for flexibility
    attributes = Column(JSON, nullable=True)


class BomItem(Base):
    """Top-level BOM item (e.g. A33293101).

    Features are stored in a separate table and related via a
    one-to-many relationship.
    """

    __tablename__ = "bom_items"

    id = Column(Integer, primary_key=True, index=True)
    item_id = Column(String, unique=True, index=True, nullable=False)
    description = Column(String, nullable=True)
    category = Column(String, index=True, nullable=True)
    product_type = Column(String, index=True, nullable=True)
    priority = Column(Integer, index=True, nullable=True)

    features = relationship("BomFeature", back_populates="item", cascade="all, delete-orphan")


class BomFeature(Base):
    """Individual legacy feature for a BOM item.

    Values are stored as a JSON array of strings for flexibility.
    """

    __tablename__ = "bom_features"

    id = Column(Integer, primary_key=True, index=True)
    item_id = Column(Integer, ForeignKey("bom_items.id", ondelete="CASCADE"), nullable=False)
    feature_id = Column(String, index=True, nullable=False)
    description = Column(String, nullable=True)
    unit = Column(String, nullable=True)
    condition = Column(String, nullable=True)
    formula = Column(String, nullable=True)
    values = Column("values_json", JSON, nullable=True)

    item = relationship("BomItem", back_populates="features")


class GlobalMapping(Base):
    """Global mapping definition shared across items.

    - legacy_feature_ids: list of legacy feature IDs this mapping applies to
    - new_attribute_id: target PLM attribute ID
    - value_mappings: JSON object mapping legacy values to new values
    """

    __tablename__ = "global_mappings"

    id = Column(Integer, primary_key=True, index=True)
    legacy_feature_ids = Column(JSON, nullable=False)
    new_attribute_id = Column(String, nullable=False)
    attribute_type = Column(String, nullable=False, default="")
    value_mappings = Column(JSON, nullable=True)
    # Phase 4.2: Optimistic locking version column
    version = Column(Integer, nullable=False, default=1)
    # Phase 4.3: Audit trail columns
    created_by = Column(String, nullable=True)
    modified_by = Column(String, nullable=True)
    modified_at = Column(Float, nullable=True)


class WorkspaceMapping(Base):
    """Workspace-level mapping rows used by Mapping Workspace.

    One row represents a concrete mapping of one legacy item/feature/value
    to one target attribute/value. The unique key keeps latest-only semantics.
    """

    __tablename__ = "workspace_mappings"
    __table_args__ = (
        UniqueConstraint(
            "legacy_item_id",
            "legacy_feature_id",
            "legacy_value",
            name="uq_workspace_mappings_item_feature_value",
        ),
        Index("ix_workspace_mappings_item_feature", "legacy_item_id", "legacy_feature_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    legacy_item_id = Column(String, index=True, nullable=False)
    legacy_feature_id = Column(String, index=True, nullable=False)
    legacy_value = Column(String, nullable=False, default="")
    new_attribute_id = Column(String, nullable=False)
    new_value = Column(String, nullable=False, default="")
    attribute_type = Column(String, nullable=False, default="")
    condition = Column(String, nullable=True)
    formula = Column(String, nullable=True)
    mapped_from = Column(String, nullable=False, default="global")
    signed_on_by_user_id = Column(String, index=True, nullable=True)
    signed_on_by_username = Column(String, nullable=True)
    signed_on_at = Column(Float, nullable=True)
    updated_at = Column(Float, nullable=False, default=0)
    # Phase 4.2: Optimistic locking version column
    version = Column(Integer, nullable=False, default=1)
    # Phase 4.3: Audit trail columns
    created_by = Column(String, nullable=True)
    modified_by = Column(String, nullable=True)
    modified_at = Column(Float, nullable=True)


class ValueList(Base):
    """Flat value-list table: one row per allowed value.

    Multiple rows sharing the same ``valuelist_id`` form a single list.
    """

    __tablename__ = "value_list"

    id = Column(Integer, primary_key=True, index=True)
    valuelist_id = Column(String, index=True, nullable=False)
    valuelist_id_description = Column(String, nullable=True)
    unit = Column(String, nullable=True)
    value = Column(String, nullable=False)
    value_description = Column(String, nullable=True)


class MappingGenerationJob(Base):
    """Tracks async generation state for workspace mapping auto-population."""

    __tablename__ = "mapping_generation_jobs"

    id = Column(Integer, primary_key=True, index=True)
    status = Column(String, index=True, nullable=False)  # queued|running|completed|failed
    triggered_by_user_id = Column(String, index=True, nullable=True)
    triggered_by_username = Column(String, nullable=True)
    trigger_source = Column(String, nullable=True)

    total_features = Column(Integer, nullable=False, default=0)
    processed_features = Column(Integer, nullable=False, default=0)
    total_values = Column(Integer, nullable=False, default=0)
    processed_values = Column(Integer, nullable=False, default=0)
    generated_rows = Column(Integer, nullable=False, default=0)

    started_at = Column(Float, nullable=True)
    finished_at = Column(Float, nullable=True)
    updated_at = Column(Float, nullable=False, default=0)
    error_message = Column(String, nullable=True)


class ItemLock(Base):
    """Database-backed item lock for atomic locking (eliminates TOCTOU race)."""

    __tablename__ = "item_locks"

    id = Column(Integer, primary_key=True, index=True)
    item_id = Column(String, unique=True, nullable=False, index=True)
    user_id = Column(String, nullable=False, index=True)
    user_name = Column(String, nullable=True)
    acquired_at = Column(Float, nullable=False)


class TokenBlacklist(Base):
    """Revoked JWT tokens (jti claim). Checked on every authenticated request."""

    __tablename__ = "token_blacklist"

    id = Column(Integer, primary_key=True, index=True)
    jti = Column(String, unique=True, nullable=False, index=True)
    expires_at = Column(Float, nullable=False)


class BomHierarchy(Base):
    """BOM hierarchy rows uploaded via CSV."""

    __tablename__ = "bom_hierarchy"

    id = Column(Integer, primary_key=True, index=True)
    level = Column(Integer, nullable=True)
    parent_bom = Column(String, index=True, nullable=True)
    item_id = Column(String, index=True, nullable=False)
    description = Column(String, nullable=True)
    qty = Column(Float, nullable=True)
    unit = Column(String, nullable=True)
    condition = Column(String, nullable=True)
    formula = Column(String, nullable=True)
    created_at = Column(Float, nullable=True)
    created_by = Column(String, nullable=True)


class AuditLog(Base):
    """Audit trail for destructive / sensitive operations."""

    __tablename__ = "audit_log"

    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(Float, nullable=False)
    user_id = Column(String, nullable=True)
    username = Column(String, nullable=True)
    action = Column(String, nullable=False)
    detail = Column(String, nullable=True)
