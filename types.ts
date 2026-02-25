
export type DataCategory = 'mapping' | 'classification' | 'values' | 'bom' | 'users';
export type ConnectionMode = 'REMOTE_SQL' | 'LOCAL_MOCK' | 'CONNECTING';

export interface User {
  userId: string;
  userName: string;
  password: string;
  role: 'admin' | 'user';
}

export interface LegacyFeature {
  featureId: string;
  description: string;
  values: string[];
  // Optional per-value descriptions, keyed by raw value
  valueDescriptions?: Record<string, string>;
}

export interface LegacyItem {
  itemId: string;
  description: string;
  features: LegacyFeature[];
}

export interface NewAttribute {
  attributeId: string;
  description: string;
  allowedValues?: string[];
  // Optional per-value descriptions, keyed by allowed value
  valueDescriptions?: Record<string, string>;
}

export interface NewClassification {
  classId: string;
  className: string;
  attributes: NewAttribute[];
}

export interface GlobalMapping {
  legacyFeatureIds: string[];
  newAttributeId: string;
  valueMappings: Record<string, string>;
}

export interface ItemLock {
  itemId: string;
  userId: string;
  userName: string;
  timestamp: number;
}

export type LocalItemMappings = Record<string, GlobalMapping[]>;

// Per-item manual values for class-scoped target attributes that
// do not originate from a specific legacy feature.
// Shape: { [itemId]: { [attributeId]: value } }
export type ClassAttributeValues = Record<string, Record<string, string>>;

export interface DatabaseState {
  bom: LegacyItem[];
  mappings: GlobalMapping[];
  classifications: NewClassification[];
  localMappings: LocalItemMappings;
  classAttributeValues?: ClassAttributeValues;
  itemClassifications: Record<string, string>;
  locks: Record<string, ItemLock>;
  users: User[];
}

export interface AIClassificationSuggestion {
  classId: string;
  confidence: number;
  reason: string;
}

export interface FeatureFlags {
  useNewClassTargetMapping: boolean;
}
