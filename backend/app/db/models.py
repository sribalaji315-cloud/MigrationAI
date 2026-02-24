from sqlalchemy import Column, Integer, JSON, String, ForeignKey
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
    value_mappings = Column(JSON, nullable=True)


class LocalAttributeMapping(Base):
    """Per-item, per-value mapping overrides captured from the workspace.

    Each row represents the effective mapping of a legacy value on a
    specific legacy attribute for a given BOM item to a new attribute
    and value.
    """

    __tablename__ = "local_attribute_mappings"

    id = Column(Integer, primary_key=True, index=True)
    item_id = Column(String, index=True, nullable=False)
    item_description = Column(String, nullable=True)
    legacy_attribute_id = Column(String, index=True, nullable=False)
    legacy_value = Column(String, nullable=False)
    new_attribute_id = Column(String, nullable=False)
    new_value = Column(String, nullable=False)
