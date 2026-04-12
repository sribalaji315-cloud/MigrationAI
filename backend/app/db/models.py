from sqlalchemy import Column, Integer, JSON, String, ForeignKey, Float, UniqueConstraint, Index
from sqlalchemy.orm import relationship
from .session import Base


class AppConfig(Base):
    """Single-row application configuration (replaces the old AppState JSON blob)."""

    __tablename__ = "app_config"

    id = Column(Integer, primary_key=True, index=True)
    mapping_type_config = Column(JSON, nullable=True)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role = Column(String, default="user")
    approval_status = Column(String, default="pending")


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
    classification = Column(String, index=True, nullable=True)
    ml_predictions = Column(JSON, nullable=True)

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
    status = Column(String, nullable=False, default="active")  # active|deprecated|ignored
    ignored_values = Column(JSON, nullable=True)  # list of legacy values to exclude
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
    value_status = Column(String, nullable=True, index=True)  # null|discontinued|ignored|deprecated
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


class ItemClassAttributeValue(Base):
    """Per-item user-entered values for target-only class attributes.

    When a user assigns a classification to a BOM item and fills in values
    for target attributes that have no legacy feature source, each value is
    stored here.  ``class_id`` is a lookup column so values are scoped per
    classification — switching classes preserves previously-entered values.
    """

    __tablename__ = "item_class_attribute_values"
    __table_args__ = (
        UniqueConstraint(
            "item_id",
            "class_id",
            "attribute_id",
            name="uq_item_class_attr_val",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    item_id = Column(String, index=True, nullable=False)
    class_id = Column(String, index=True, nullable=False)
    attribute_id = Column(String, nullable=False)
    value = Column(String, nullable=False, default="")


class FeatureCombinationJob(Base):
    """Tracks async feature-combination build job state."""

    __tablename__ = "feature_combination_jobs"

    id = Column(Integer, primary_key=True, index=True)
    status = Column(String, index=True, nullable=False)  # queued|running|completed|failed
    triggered_by_user_id = Column(String, nullable=True)
    triggered_by_username = Column(String, nullable=True)
    total_features = Column(Integer, nullable=False, default=0)
    processed_features = Column(Integer, nullable=False, default=0)
    generated_rows = Column(Integer, nullable=False, default=0)
    started_at = Column(Float, nullable=True)
    finished_at = Column(Float, nullable=True)
    updated_at = Column(Float, nullable=False, default=0)
    error_message = Column(String, nullable=True)


class FeatureCombination(Base):
    """Pre-built summary: one row per unique feature_id + normalized value set.

    The ``normalized_values_key`` is a deterministic string built by sorting,
    deduplicating and joining the feature values so that order-insensitive
    comparison is a simple string equality check.
    """

    __tablename__ = "feature_combinations"
    __table_args__ = (
        Index("ix_feature_combinations_feature_key", "feature_id", "normalized_values_key"),
    )

    id = Column(Integer, primary_key=True, index=True)
    feature_id = Column(String, index=True, nullable=False)
    description = Column(String, nullable=True)
    unit = Column(String, nullable=True)
    attribute_type = Column(String, index=True, nullable=True)
    normalized_values_key = Column(String, nullable=False)
    normalized_values_json = Column(JSON, nullable=False)
    item_count = Column(Integer, nullable=False, default=0)
    legacy_value_count = Column(Integer, nullable=False, default=0)
    d365_attribute_id = Column(String, nullable=True)
    d365_values_json = Column(JSON, nullable=True)  # { legacyVal: d365Val }
    mapped_value_count = Column(Integer, nullable=False, default=0)
    mapping_status = Column(String, index=True, nullable=False, default="unmapped")  # complete|partial|unmapped
    priorities_json = Column(JSON, nullable=True)
    item_ids_json = Column(JSON, nullable=True)  # list of item_id strings in this combo
    built_at = Column(Float, nullable=True)


class ConsolidationPlan(Base):
    """Saved consolidation decision for a feature_id.

    Stores the chosen merge strategy, the canonical value lists produced,
    and the mapping of items to each list.
    """

    __tablename__ = "consolidation_plans"

    id = Column(Integer, primary_key=True, index=True)
    feature_id = Column(String, unique=True, index=True, nullable=False)
    strategy = Column(String, nullable=False)  # subset_merge | full_union | no_merge
    status = Column(String, nullable=False, default="completed")  # computing | completed | failed
    lists_needed = Column(Integer, nullable=False, default=1)
    canonical_lists_json = Column(JSON, nullable=False)  # [[val1, val2], [val3]]
    item_assignments_json = Column(JSON, nullable=False)  # [[item1, item2], [item3]]
    details_json = Column(JSON, nullable=True)  # per-list items + variant breakdowns for display
    total_noise = Column(Integer, nullable=False, default=0)
    max_noise_per_item = Column(Integer, nullable=False, default=0)
    error_message = Column(String, nullable=True)
    created_by = Column(String, nullable=True)
    created_at = Column(Float, nullable=True)
    updated_by = Column(String, nullable=True)
    updated_at = Column(Float, nullable=True)


class AttributeCombinationJob(Base):
    """Tracks async attribute-combination build job state."""

    __tablename__ = "attribute_combination_jobs"

    id = Column(Integer, primary_key=True, index=True)
    status = Column(String, index=True, nullable=False)  # queued|running|completed|failed
    triggered_by_user_id = Column(String, nullable=True)
    triggered_by_username = Column(String, nullable=True)
    selected_attribute_types = Column(JSON, nullable=True)  # list of attribute type strings chosen by user
    total_items = Column(Integer, nullable=False, default=0)
    processed_items = Column(Integer, nullable=False, default=0)
    generated_rows = Column(Integer, nullable=False, default=0)
    started_at = Column(Float, nullable=True)
    finished_at = Column(Float, nullable=True)
    updated_at = Column(Float, nullable=False, default=0)
    error_message = Column(String, nullable=True)


class AttributeCombination(Base):
    """Pre-built summary: one row per unique set of attribute/feature IDs across BOM items.

    Each row represents all BOM items that have the exact same set of feature/attribute IDs
    (their attribute fingerprint). ``feature_ids_key`` is a pipe-joined sorted list of feature IDs.
    """

    __tablename__ = "attribute_combinations"
    __table_args__ = (
        Index("ix_attribute_combinations_key", "feature_ids_key"),
    )

    id = Column(Integer, primary_key=True, index=True)
    feature_ids_key = Column(String, nullable=False)
    feature_ids_json = Column(JSON, nullable=False)   # sorted list of feature_id strings
    feature_count = Column(Integer, nullable=False, default=0)
    item_count = Column(Integer, nullable=False, default=0)
    item_ids_json = Column(JSON, nullable=True)         # list of item_id strings
    attribute_types_json = Column(JSON, nullable=True)  # sorted distinct attribute types for the features
    priorities_json = Column(JSON, nullable=True)       # sorted distinct priorities
    categories_json = Column(JSON, nullable=True)       # sorted distinct categories
    product_types_json = Column(JSON, nullable=True)    # sorted distinct product types
    built_at = Column(Float, nullable=True)


class MigrationManifestJob(Base):
    """Tracks async migration-manifest build job state."""

    __tablename__ = "migration_manifest_jobs"

    id = Column(Integer, primary_key=True, index=True)
    status = Column(String, index=True, nullable=False)  # queued|running|completed|failed
    triggered_by_username = Column(String, nullable=True)
    total_items = Column(Integer, nullable=False, default=0)
    processed_items = Column(Integer, nullable=False, default=0)
    generated_rows = Column(Integer, nullable=False, default=0)
    started_at = Column(Float, nullable=True)
    finished_at = Column(Float, nullable=True)
    updated_at = Column(Float, nullable=False, default=0)
    error_message = Column(String, nullable=True)


class MigrationManifestEntry(Base):
    """One row per item x legacy feature — the unified merge output.

    Captures original mappings, value-merge noise, and attribute-merge noise
    in a single flat table for the Migration Manifest view.
    """

    __tablename__ = "migration_manifest_entries"
    __table_args__ = (
        Index("ix_manifest_item", "item_id"),
        Index("ix_manifest_feature", "legacy_feature_id"),
        Index("ix_manifest_target", "target_attribute_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    item_id = Column(String, nullable=False)
    item_description = Column(String, nullable=True)
    item_category = Column(String, nullable=True)
    item_product_type = Column(String, nullable=True)
    item_priority = Column(Integer, nullable=True)
    legacy_feature_id = Column(String, nullable=False)
    target_attribute_id = Column(String, nullable=True)
    attribute_type = Column(String, nullable=True)
    source = Column(String, nullable=False, default="original")  # original|value_merge|attr_merge
    is_noise = Column(Integer, nullable=False, default=0)  # 0 or 1
    noise_type = Column(String, nullable=True)  # missing_value|missing_attribute|null
    original_values_json = Column(JSON, nullable=True)  # legacy values the item actually had
    target_values_json = Column(JSON, nullable=True)     # mapped target values
    noise_values_json = Column(JSON, nullable=True)      # values added by value merge
    has_mapping = Column(Integer, nullable=False, default=0)  # 0 or 1
    is_accepted = Column(Integer, nullable=False, default=0)  # 0 or 1
    accepted_at = Column(Float, nullable=True)
    accepted_by_username = Column(String, nullable=True)
    combo_item_count = Column(Integer, nullable=False, default=1)  # items sharing same feature combo
    built_at = Column(Float, nullable=True)


class MergedWorkspaceMapping(Base):
    """New workspace mapping rows produced by accepting Migration Manifest merges.

    Same schema as WorkspaceMapping but stored in a separate table so the
    original workspace_mappings (and all dashboard metrics tied to it) stay
    untouched.  Users can toggle between old and new mappings in the UI.
    """

    __tablename__ = "merged_workspace_mappings"
    __table_args__ = (
        UniqueConstraint(
            "legacy_item_id",
            "legacy_feature_id",
            "legacy_value",
            name="uq_merged_ws_mappings_item_feature_value",
        ),
        Index("ix_merged_ws_mappings_item_feature", "legacy_item_id", "legacy_feature_id"),
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
    mapped_from = Column(String, nullable=False, default="manifest")
    value_status = Column(String, nullable=True, index=True)
    manifest_entry_id = Column(Integer, nullable=True, index=True)
    signed_on_by_user_id = Column(String, index=True, nullable=True)
    signed_on_by_username = Column(String, nullable=True)
    signed_on_at = Column(Float, nullable=True)
    updated_at = Column(Float, nullable=False, default=0)
    version = Column(Integer, nullable=False, default=1)
    created_by = Column(String, nullable=True)
    modified_by = Column(String, nullable=True)
    modified_at = Column(Float, nullable=True)
    # Valuelist strategy columns
    valuelist_id = Column(String, nullable=True, index=True)
    is_effective_fixed = Column(Integer, nullable=False, default=0)


class ValuelistStrategyJob(Base):
    """Tracks async valuelist-strategy analysis job state."""

    __tablename__ = "valuelist_strategy_jobs"

    id = Column(Integer, primary_key=True, index=True)
    status = Column(String, index=True, nullable=False)  # queued|running|completed|failed
    strategy = Column(String, nullable=False, default="conservative")  # conservative|aggressive
    total_attributes = Column(Integer, nullable=False, default=0)
    fixed_only_count = Column(Integer, nullable=False, default=0)
    valuelist_count = Column(Integer, nullable=False, default=0)
    unique_valuelists = Column(Integer, nullable=False, default=0)
    merged_valuelists = Column(Integer, nullable=True)
    error_message = Column(String, nullable=True)
    created_at = Column(Float, nullable=True)
    completed_at = Column(Float, nullable=True)


class TargetAttributeProfile(Base):
    """Per-target-attribute analysis produced by the valuelist strategy pipeline.

    Classifies each target attribute as fixed_only or valuelist, stores
    canonical values, and groups deduplicated lists via dedup_group_key.
    """

    __tablename__ = "target_attribute_profiles"

    id = Column(Integer, primary_key=True, index=True)
    target_attribute_id = Column(String, unique=True, index=True, nullable=False)
    classification = Column(String, nullable=False)  # fixed_only|valuelist
    valuelist_id = Column(String, nullable=True, index=True)
    total_items = Column(Integer, nullable=False, default=0)
    fixed_value_items = Column(Integer, nullable=False, default=0)
    multi_value_items = Column(Integer, nullable=False, default=0)
    canonical_values_json = Column(JSON, nullable=True)
    noise_values_json = Column(JSON, nullable=True)
    dedup_group_key = Column(String, nullable=True, index=True)
    job_id = Column(Integer, nullable=True, index=True)
    created_at = Column(Float, nullable=True)
    updated_at = Column(Float, nullable=True)
