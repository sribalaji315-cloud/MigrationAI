import { parseCsv, buildCsv, splitCsvLine, parseDelimited } from '../utils/csvHelpers';

export interface MergeGroupFeaturesInput {
  itemFeatureRows: { [key: string]: string }[];
  groupFeatureRows: { [key: string]: string }[];
  /** Column mapping for the item-features CSV */
  itemCols: {
    itemId: string;
    description: string;
    category: string;
    productType: string;
    priority: string;
    featureId: string;
    featureDescription: string;
    option: string;
    optionDescription: string;
    unit: string;
    groupFeature: string;
    tillDate: string;
  };
  /** Column mapping for the group-features CSV */
  groupCols: {
    featureGroup: string;
    feature: string;
    featureDesc: string;
    option: string;
    optionDesc: string;
    condition: string;
    tillDate: string;
  };
}

export interface MergedBomItem {
  itemId: string;
  description: string;
  category: string;
  productType: string;
  priority?: number;
  features: {
    featureId: string;
    description: string;
    values: string[];
    unit?: string;
    condition?: string;
    valueDescriptions?: Record<string, string>;
    valueTillDates?: Record<string, string>;
  }[];
}

export type CsvWorkerRequest =
  | { type: 'parse'; text: string }
  | { type: 'parseAuto'; text: string }
  | { type: 'build'; rows: string[][] }
  | { type: 'mergeGroupFeatures'; input: MergeGroupFeaturesInput };

export type CsvWorkerResponse =
  | { type: 'parse'; rows: { [key: string]: string }[] }
  | { type: 'parseAuto'; rows: { [key: string]: string }[] }
  | { type: 'build'; csv: string }
  | { type: 'mergeGroupFeatures'; items: MergedBomItem[]; stats: { totalItems: number; totalFeatures: number; groupFeaturesExpanded: number } }
  | { type: 'error'; message: string };

/**
 * Merge item-feature rows with group-feature sub-features.
 *
 * File 1 (item features): one row per item+feature+option.
 * File 2 (group features): one row per group+sub-feature+option, grouped by FeatureGroup.
 *
 * Linkage: an item "uses" a group when one of its own feature codes matches a
 *   FeatureGroup code in File 2. That group's sub-features are then expanded into
 *   the item's feature list. As a fallback, a non-empty `groupFeature` column value
 *   on an item row also triggers expansion of the named group.
 */
function mergeGroupFeatures(input: MergeGroupFeaturesInput): { items: MergedBomItem[]; stats: { totalItems: number; totalFeatures: number; groupFeaturesExpanded: number } } {
  const { itemFeatureRows, groupFeatureRows, itemCols, groupCols } = input;

  // --- 1. Index group features: groupName → sub-features ---
  // Each group has multiple sub-features; each sub-feature may have multiple options.
  type SubFeature = {
    featureId: string;
    description: string;
    values: string[];
    condition?: string;
    valueDescriptions: Record<string, string>;
    valueTillDates: Record<string, string>;
  };
  const groupMap = new Map<string, SubFeature[]>();

  for (const row of groupFeatureRows) {
    const groupName = (row[groupCols.featureGroup] || '').trim();
    if (!groupName) continue;

    const featureId = (row[groupCols.feature] || '').trim();
    if (!featureId) continue;

    const featureDesc = (row[groupCols.featureDesc] || '').trim();
    const option = (row[groupCols.option] || '').trim();
    const optionDesc = (row[groupCols.optionDesc] || '').trim();
    const condition = (row[groupCols.condition] || '').trim();

    if (!groupMap.has(groupName)) groupMap.set(groupName, []);
    const subFeatures = groupMap.get(groupName)!;

    let sub = subFeatures.find(s => s.featureId === featureId);
    if (!sub) {
      sub = { featureId, description: featureDesc || featureId, values: [], condition: condition || undefined, valueDescriptions: {}, valueTillDates: {} };
      subFeatures.push(sub);
    }
    if (option && !sub.values.includes(option)) {
      sub.values.push(option);
      if (optionDesc) sub.valueDescriptions[option] = optionDesc;
    }
    const groupTillDate = groupCols.tillDate ? (row[groupCols.tillDate] || '').trim() : '';
    if (option && groupTillDate) {
      sub.valueTillDates[option] = groupTillDate;
    }
  }

  // --- 2. Build item map from item-feature rows ---
  const byItem = new Map<string, MergedBomItem>();
  // Fallback: explicit group names named by an item's `groupFeature` column
  const itemGroupTriggers = new Map<string, Set<string>>();
  let groupFeaturesExpanded = 0;

  for (const row of itemFeatureRows) {
    const itemId = (row[itemCols.itemId] || '').trim();
    if (!itemId) continue;

    let item = byItem.get(itemId);
    if (!item) {
      const rawPri = (row[itemCols.priority] || '').trim();
      const priority = rawPri ? parseInt(rawPri, 10) : undefined;
      item = {
        itemId,
        description: (row[itemCols.description] || '').trim(),
        category: (row[itemCols.category] || '').trim(),
        productType: (row[itemCols.productType] || '').trim(),
        ...(priority != null && !isNaN(priority) ? { priority } : {}),
        features: [],
      };
      byItem.set(itemId, item);
    }

    // Add the direct feature (option)
    const featureId = (row[itemCols.featureId] || '').trim();
    if (featureId) {
      const featureDesc = (row[itemCols.featureDescription] || '').trim();
      const option = (row[itemCols.option] || '').trim();
      const optionDesc = (row[itemCols.optionDescription] || '').trim();
      const unit = (row[itemCols.unit] || '').trim();

      let feat = item.features.find(f => f.featureId === featureId);
      if (!feat) {
        feat = { featureId, description: featureDesc || featureId, values: [], unit: unit || undefined, valueDescriptions: {} };
        item.features.push(feat);
      }
      if (option && !feat.values.includes(option)) {
        feat.values.push(option);
        if (optionDesc) {
          if (!feat.valueDescriptions) feat.valueDescriptions = {};
          feat.valueDescriptions[option] = optionDesc;
        }
      }
      const itemTillDate = itemCols.tillDate ? (row[itemCols.tillDate] || '').trim() : '';
      if (option && itemTillDate) {
        if (!feat.valueTillDates) feat.valueTillDates = {};
        feat.valueTillDates[option] = itemTillDate;
      }
    }

    // Fallback linkage: record any explicit group named by the item's groupFeature column
    const groupCol = itemCols.groupFeature ? (row[itemCols.groupFeature] || '').trim() : '';
    if (groupCol) {
      let set = itemGroupTriggers.get(itemId);
      if (!set) { set = new Set<string>(); itemGroupTriggers.set(itemId, set); }
      set.add(groupCol);
    }
  }

  // --- 3. Expand group sub-features into each item ---
  // An item triggers a group when one of its own feature codes matches a FeatureGroup,
  // or when its groupFeature column named the group (fallback). Snapshot the trigger
  // names before expanding so newly added sub-features don't recursively re-expand.
  for (const item of byItem.values()) {
    const triggers = new Set<string>();
    for (const f of item.features) triggers.add(f.featureId);
    const explicit = itemGroupTriggers.get(item.itemId);
    if (explicit) for (const g of explicit) triggers.add(g);

    for (const groupName of triggers) {
      const subs = groupMap.get(groupName);
      if (!subs) continue;
      for (const sub of subs) {
        let feat = item.features.find(f => f.featureId === sub.featureId);
        if (!feat) {
          feat = {
            featureId: sub.featureId,
            description: sub.description,
            values: [...sub.values],
            condition: sub.condition,
            valueDescriptions: { ...sub.valueDescriptions },
            valueTillDates: { ...sub.valueTillDates },
          };
          item.features.push(feat);
          groupFeaturesExpanded++;
        } else {
          // Merge values from group into existing feature
          for (const v of sub.values) {
            if (!feat.values.includes(v)) {
              feat.values.push(v);
              if (sub.valueDescriptions[v]) {
                if (!feat.valueDescriptions) feat.valueDescriptions = {};
                feat.valueDescriptions[v] = sub.valueDescriptions[v];
              }
              if (sub.valueTillDates[v]) {
                if (!feat.valueTillDates) feat.valueTillDates = {};
                feat.valueTillDates[v] = sub.valueTillDates[v];
              }
            }
          }
        }
      }
    }
  }

  const items = Array.from(byItem.values());
  const totalFeatures = items.reduce((s, it) => s + it.features.length, 0);
  return { items, stats: { totalItems: items.length, totalFeatures, groupFeaturesExpanded } };
}

self.onmessage = (e: MessageEvent<CsvWorkerRequest & { _id?: number }>) => {
  try {
    const msg = e.data;
    const _id = msg._id;
    if (msg.type === 'parse') {
      const rows = parseCsv(msg.text);
      (self as any).postMessage({ type: 'parse', rows, _id });
    } else if (msg.type === 'parseAuto') {
      const rows = parseDelimited(msg.text);
      (self as any).postMessage({ type: 'parseAuto', rows, _id });
    } else if (msg.type === 'build') {
      const csv = buildCsv(msg.rows);
      (self as any).postMessage({ type: 'build', csv, _id });
    } else if (msg.type === 'mergeGroupFeatures') {
      const result = mergeGroupFeatures(msg.input);
      (self as any).postMessage({ type: 'mergeGroupFeatures', ...result, _id });
    }
  } catch (err: any) {
    (self as any).postMessage({ type: 'error', message: err?.message || String(err), _id: e.data._id });
  }
};
