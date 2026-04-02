
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
  unit?: string;
  // Optional per-value descriptions, keyed by raw value
  valueDescriptions?: Record<string, string>;
}

export interface LegacyItem {
  itemId: string;
  description: string;
  category?: string;
  productType?: string;
  features: LegacyFeature[];
}

export interface NewAttribute {
  attributeId: string;
  description: string;
  unit?: string;
  allowedValues?: string[];
  // Optional per-value descriptions, keyed by allowed value
  valueDescriptions?: Record<string, string>;
}

export interface NewClassification {
  classId: string;
  className: string;
  attributes: NewAttribute[];
}

export interface ValueListRow {
  id?: number;
  valuelistId: string;
  valuelistIdDescription?: string;
  unit?: string;
  value: string;
  valueDescription?: string;
}

export interface ValueListGroup {
  valuelistId: string;
  valuelistIdDescription?: string;
  unit?: string;
  valueCount: number;
}

export type MappingAttributeType = string;

export interface MappingTypeConfig {
  availableTypes: string[];
  includedTypes: string[];
}

export interface GlobalMapping {
  legacyFeatureIds: string[];
  newAttributeId: string;
  valueMappings: Record<string, string>;
  attributeType: MappingAttributeType;
  mappedFrom?: 'global' | 'local';
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
  mappingTypeConfig?: MappingTypeConfig;
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

export interface WorkspaceMappingRow {
  itemId: string;
  legacyFeatureId: string;
  legacyValue: string;
  newAttributeId: string;
  newValue: string;
  attributeType?: string;
  mappedFrom?: string;
  signedOnByUserId?: string | null;
  signedOnByUsername?: string | null;
  signedOnAt?: number | null;
  updatedAt?: number | null;
}

export interface MappingGenerationProgress {
  id?: number;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
  isActive: boolean;
  progress: number;
  totalFeatures: number;
  processedFeatures: number;
  totalValues: number;
  processedValues: number;
  generatedRows: number;
  triggeredByUserId?: string | null;
  triggeredByUsername?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  updatedAt?: number | null;
  error?: string | null;
}
