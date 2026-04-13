
export type DataCategory = 'mapping' | 'classification' | 'values' | 'bom' | 'users';
export type ConnectionMode = 'REMOTE_SQL' | 'LOCAL_MOCK' | 'CONNECTING';

export interface User {
  userId: string;
  userName: string;
  password: string;
  role: 'admin' | 'user';
  approvalStatus?: 'pending' | 'approved' | 'rejected';
}

export interface LegacyFeature {
  featureId: string;
  description: string;
  values: string[];
  unit?: string;
  condition?: string;
  formula?: string;
  // Optional per-value descriptions, keyed by raw value
  valueDescriptions?: Record<string, string>;
  // Optional per-value till-dates (YYYY-MM-DD), keyed by raw value
  valueTillDates?: Record<string, string>;
}

export interface MLPrediction {
  classId: string;
  className: string;
  confidence: number;
}

export interface MLSettings {
  useSynonymAssist: boolean;
  synonymThreshold: number;
  synonymWeight: number;
}

export interface LegacyItem {
  itemId: string;
  description: string;
  category?: string;
  productType?: string;
  priority?: number;
  classification?: string;
  mlPredictions?: MLPrediction[];
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
  id?: number;
  _originalId?: number;
  _originalLegacyFeatureIds?: string[];
  _originalNewAttributeId?: string;
  _clientEditedAt?: number;
  legacyFeatureIds: string[];
  newAttributeId: string;
  valueMappings: Record<string, string>;
  attributeType: MappingAttributeType;
  mappedFrom?: 'global' | 'local';
  status?: 'active' | 'deprecated' | 'ignored';
  ignoredValues?: string[];
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
  condition?: string;
  formula?: string;
  mappedFrom?: string;
  valueStatus?: 'discontinued' | 'ignored' | 'deprecated' | null;
  signedOnByUserId?: string | null;
  signedOnByUsername?: string | null;
  signedOnAt?: number | null;
  updatedAt?: number | null;
  allGlobalTargets?: string[];
  candidateAttributeIds?: string[] | null;
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

export interface BomHierarchyItem {
  id?: number;
  level?: number;
  parentBom?: string;
  itemId: string;
  description?: string;
  qty?: number;
  unit?: string;
  condition?: string;
  formula?: string;
  createdAt?: number;
  createdBy?: string;
}

export interface FeatureCombinationJobProgress {
  id?: number;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
  isActive: boolean;
  progress: number;
  totalFeatures: number;
  processedFeatures: number;
  generatedRows: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  error?: string | null;
}

export interface FeatureCombinationRow {
  id: number;
  featureId: string;
  description: string;
  unit: string;
  attributeType: string;
  normalizedValues: string[];
  normalizedValuesKey: string;
  itemCount: number;
  filteredItemCount?: number | null;
  legacyValueCount: number;
  comboCountForFeature: number;
  d365AttributeId: string;
  d365Values: Record<string, string>;
  mappedValueCount: number;
  mappingStatus: 'complete' | 'partial' | 'unmapped';
  priorities: number[];
  builtAt?: number | null;
  savedPlanStrategy?: string | null;
}

export interface FeatureCombinationItem {
  itemId: string;
  description: string;
  category: string;
  productType: string;
  priority?: number | null;
  classification: string;
}

export interface ConsolidationVariant {
  comboId: number;
  values: string[];
  itemCount: number;
  priorities: number[];
  productTypes: string[];
  isSubsetOf: number[];
  isSupersetOf: number[];
  noiseIfUnion: number;
  noiseItems: number;
}

export interface MergeOption {
  label: string;
  canonicalValues: string[][];
  listsNeeded: number;
  totalNoise: number;
  maxNoisePerItem: number;
}

export interface CrossFeatureMatch {
  featureId: string;
  unionValues: string[];
  relationship: 'identical' | 'subset' | 'superset' | 'overlap';
  overlapPercent: number;
}

export interface VariantComparisonResponse {
  featureId: string;
  unionValues: string[];
  variants: ConsolidationVariant[];
}

export interface CrossFeatureResponse {
  featureId: string;
  crossFeatureMatches: CrossFeatureMatch[];
}

export interface ConsolidationAnalysis {
  featureId: string;
  description: string;
  totalVariants: number;
  totalItems: number;
  unionValues: string[];
  variants: ConsolidationVariant[];
  mergeOptions: MergeOption[];
  crossFeatureMatches: CrossFeatureMatch[];
}

export interface SubsetMergeListItem {
  itemId: string;
  description: string;
  category: string;
  priority?: number | null;
  productType: string;
}

export interface SubsetMergeVariant {
  comboId: number;
  values: string[];
  itemCount: number;
}

export interface SubsetMergeList {
  index: number;
  values: string[];
  itemCount: number;
  items: SubsetMergeListItem[];
  totalItemIds: string[];
  variants: SubsetMergeVariant[];
}

export interface SubsetMergeDetail {
  featureId: string;
  strategy: string;
  status: 'computing' | 'completed' | 'failed';
  listsNeeded: number;
  totalNoise: number;
  maxNoisePerItem: number;
  applied: boolean;
  appliedAt: number | null;
  appliedBy: string | null;
  errorMessage?: string | null;
  lists: SubsetMergeList[];
}

export interface AttributeCombinationJobProgress {
  id?: number;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
  isActive: boolean;
  progress: number;
  totalItems: number;
  processedItems: number;
  generatedRows: number;
  selectedAttributeTypes: string[];
  startedAt?: number | null;
  finishedAt?: number | null;
  error?: string | null;
}

export interface AttributeCombinationRow {
  id: number;
  featureIdsKey: string;
  featureIds: string[];
  featureCount: number;
  itemCount: number;
  filteredItemCount?: number | null;
  similarCount?: number;
  attributeTypes: string[];
  priorities: number[];
  categories: string[];
  productTypes: string[];
  builtAt?: number | null;
}

export interface AttributeCombinationItem {
  itemId: string;
  description: string;
  category: string;
  productType: string;
  priority?: number | null;
}

export interface AttrComboSimilarFingerprint {
  comboId: number;
  featureIds: string[];
  featureCount: number;
  itemCount: number;
  relationship: 'identical' | 'subset' | 'superset' | 'overlap';
  overlapPercent: number;
  commonAttributes: string[];
  uniqueAttributes: string[];
}

export interface AttrComboConsolidationAnalysis {
  comboId: number;
  fingerprint: string[];
  featureCount: number;
  totalSimilar: number;
  totalItems: number;
  commonAttributes: string[];
  unionAttributes: string[];
  similarCombos: AttrComboSimilarFingerprint[];
  mergeOptions: MergeOption[];
}

export interface MigrationManifestRow {
  id: number;
  itemId: string;
  itemDescription: string;
  itemCategory: string;
  itemProductType: string;
  itemPriority?: number | null;
  legacyFeatureId: string;
  targetAttributeId: string;
  attributeType: string;
  source: 'original' | 'value_merge' | 'attr_merge';
  isNoise: boolean;
  noiseType: string;
  originalValues: string[];
  targetValues: string[];
  noiseValues: string[];
  hasMapping: boolean;
  isAccepted: boolean;
  acceptedAt?: number | null;
  acceptedBy?: string | null;
  comboItemCount: number;
  builtAt?: number | null;
  valueMappings?: Record<string, string>;
}

export interface MigrationManifestFilters {
  categories: string[];
  productTypes: string[];
  priorities: number[];
  sources: string[];
  noiseTypes: string[];
  attributeTypes: string[];
  targetAttributes: string[];
}

export interface MigrationManifestItemSummary {
  itemId: string;
  itemDescription: string;
  itemCategory: string;
  itemProductType: string;
  itemPriority?: number | null;
  totalRows: number;
  comboItemCount: number;
  valueMergeCount: number;
  mappedCount: number;
  noiseCount: number;
  sharedValuelistCount: number;
}

export interface MigrationManifestAttributeGroup {
  targetAttributeId: string;
  attributeType: string;
  features: MigrationManifestRow[];
  hasAttrMerge: boolean;
  hasValueMerge: boolean;
}

export interface MigrationManifestValueDetail {
  itemId: string;
  targetAttributeId: string;
  entries: MigrationManifestRow[];
  originalValues: string[];
  targetValues: string[];
  noiseValues: string[];
}

export interface MergedWorkspaceMappingRow {
  id: number;
  legacyItemId: string;
  legacyFeatureId: string;
  legacyValue: string;
  newAttributeId: string;
  newValue: string;
  attributeType: string;
  condition?: string | null;
  formula?: string | null;
  mappedFrom: string;
  valueStatus?: string | null;
  feasibility?: string | null;
  manifestEntryId?: number | null;
  signedOnByUsername?: string | null;
  signedOnAt?: number | null;
  updatedAt: number;
  version: number;
  createdBy?: string | null;
  modifiedBy?: string | null;
  modifiedAt?: number | null;
  valuelistId?: string | null;
  isEffectiveFixed?: boolean;
  attributeFootprint?: string | null;
  valueFootprint?: string | null;
  candidateAttributeIds?: string[] | null;
}

export interface MergedWorkspaceMappingDetail {
  mappings: MergedWorkspaceMappingRow[];
  totalMappings: number;
  comboItems: { itemId: string; description: string }[];
  totalComboItems: number;
  sharedVL: { attribute: string; values: string[]; sharedItems: string[]; totalShared: number }[];
  attributeFootprint?: string | null;
  legacyComboItems: { itemId: string; description: string }[];
  totalLegacyComboItems: number;
  legacySharedVL: { feature: string; values: string[]; sharedItems: string[]; totalShared: number }[];
  legacyFeatureFootprint?: string | null;
}

export interface MergeJob {
  hasJob: boolean;
  jobId?: number;
  status?: string;
  totalItems?: number;
  processedItems?: number;
  generatedRows?: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  errorMessage?: string | null;
}

// ---------------------------------------------------------------------------
// Valuelist Strategy types
// ---------------------------------------------------------------------------

export interface ValuelistStrategyJob {
  jobId: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  strategy: 'conservative' | 'aggressive';
  totalAttributes: number;
  fixedOnlyCount: number;
  valuelistCount: number;
  uniqueValuelists: number;
  mergedValuelists?: number | null;
  errorMessage?: string | null;
  createdAt?: number | null;
  completedAt?: number | null;
}

export interface TargetAttributeProfile {
  id: number;
  targetAttributeId: string;
  classification: 'fixed_only' | 'valuelist';
  valuelistId?: string | null;
  totalItems: number;
  fixedValueItems: number;
  multiValueItems: number;
  canonicalValues: string[];
  noiseValues: string[];
  dedupGroupKey?: string | null;
  dedupSiblings?: string[];
  jobId?: number | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface ValuelistDedupGroup {
  dedupGroupKey: string;
  valuelistId: string;
  canonicalValues: string[];
  attributes: {
    targetAttributeId: string;
    totalItems: number;
    fixedValueItems: number;
    multiValueItems: number;
  }[];
}

export interface ValuelistMergeProposal {
  listA: string;
  listB: string;
  attributesA: string[];
  attributesB: string[];
  mergedValues: string[];
  overlapPercent: number;
  isSubset: boolean;
  noiseAddedToA: number;
  noiseAddedToB: number;
  affectedItemsA: number;
  affectedItemsB: number;
}

export interface ValuelistApplyResult {
  ok: boolean;
  valuelistsCreated: number;
  valuelistRowsCreated: number;
  profilesUpdated: number;
  mappingsUpdated: number;
}
