
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

export interface DatabaseState {
  bom: LegacyItem[];
  mappings: GlobalMapping[];
  classifications: NewClassification[];
  localMappings: LocalItemMappings;
  itemClassifications: Record<string, string>;
  locks: Record<string, ItemLock>;
  users: User[];
}

export interface AIClassificationSuggestion {
  classId: string;
  confidence: number;
  reason: string;
}
