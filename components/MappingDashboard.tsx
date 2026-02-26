import React, { useMemo, useState } from 'react';
import { LegacyItem, GlobalMapping, LocalItemMappings } from '../types';

interface MappingDashboardProps {
  bom: LegacyItem[];
  mappings: GlobalMapping[];
  localMappings: LocalItemMappings;
  onClose: () => void;
  onRecompute: () => void;
}

interface DonutStatProps {
  label: string;
  value: number; // 0-1
  primaryColor: string;
  secondaryColor: string;
  description: string;
}

const DonutStat: React.FC<DonutStatProps> = ({ label, value, primaryColor, secondaryColor, description }) => {
  const size = 140;
  const strokeWidth = 14;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, value));
  const offset = circumference * (1 - clamped);
  const percent = Math.round(clamped * 100);

  return (
    <div className="flex flex-col items-center gap-2 p-4 bg-white rounded-2xl border border-slate-100 shadow-sm">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size}>
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke={secondaryColor}
              strokeWidth={strokeWidth}
              fill="none"
              strokeLinecap="round"
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke={primaryColor}
              strokeWidth={strokeWidth}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
            />
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-black text-slate-900">{percent}%</span>
          <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest text-center px-3 leading-tight">
            {label}
          </span>
        </div>
      </div>
      <p className="text-[10px] text-slate-500 font-medium text-center max-w-xs leading-snug">{description}</p>
    </div>
  );
};

const MappingDashboard: React.FC<MappingDashboardProps> = ({ bom, mappings, localMappings, onClose, onRecompute }) => {
  const [itemFilter, setItemFilter] = useState('');

  const metrics = useMemo(() => {
    const globalByFeature: Record<string, GlobalMapping> = {};
    mappings.forEach(m => {
      (m.legacyFeatureIds || []).forEach(fid => {
        if (fid && !globalByFeature[fid]) {
          globalByFeature[fid] = m;
        }
      });
    });

    let totalFeatures = 0;
    let mappedFeatures = 0;
    let totalNotRequiredFeatures = 0;
    let totalValues = 0;
    let mappedValues = 0;
    const totalItems = bom.length;
    let itemsFullyMapped = 0;

    interface ItemStat {
      itemId: string;
      description: string;
      totalFeatures: number;
      mappedFeatures: number;
      notRequiredFeatures: number;
      totalValues: number;
      mappedValues: number;
      fullyMapped: boolean;
    }
    const perItem: ItemStat[] = [];

    bom.forEach(item => {
      const localForItem = localMappings[item.itemId] || [];
      const localByFeature: Record<string, any> = {};
      localForItem.forEach(m => {
        (m.legacyFeatureIds || []).forEach(fid => {
          localByFeature[fid] = m;
        });
      });

      let itemFeatures = 0;
      let itemMappedFeatures = 0;
      let itemNotRequiredFeatures = 0;
      let itemValues = 0;
      let itemMappedValues = 0;

      item.features.forEach(feature => {
        totalFeatures += 1;
        itemFeatures += 1;

        const localMapping = localByFeature[feature.featureId];
        const globalMapping = globalByFeature[feature.featureId];
        const effective = localMapping || globalMapping || null;

        const upperAttrId = (effective && effective.newAttributeId || '').toUpperCase();
        const attributeNotRequired = !!(upperAttrId === 'NOT REQUIRED');
        const attributeMapped = !!(upperAttrId && upperAttrId !== 'UNMAPPED' && upperAttrId !== 'NOT REQUIRED');

        if (attributeNotRequired) {
          totalNotRequiredFeatures += 1;
          itemNotRequiredFeatures += 1;
        }

        if (attributeMapped) {
          mappedFeatures += 1;
          itemMappedFeatures += 1;
        }

        feature.values.forEach(v => {
          totalValues += 1;
          itemValues += 1;

          const mapped = !!(effective && effective.valueMappings && effective.valueMappings[v] !== undefined && effective.valueMappings[v] !== '');
          if (mapped) {
            mappedValues += 1;
            itemMappedValues += 1;
          }
        });
      });

      // An item with no values (but with attribute-mapped features) is considered fully mapped.
      // An item with values must have all values mapped too.
      const itemCoveredFeatures = itemMappedFeatures + itemNotRequiredFeatures;

      const itemFullyMapped =
        itemFeatures > 0 &&
        itemFeatures === itemCoveredFeatures &&
        (itemValues === 0 || itemValues === itemMappedValues);

      if (itemFullyMapped) {
        itemsFullyMapped += 1;
      }

      perItem.push({
        itemId: item.itemId,
        description: item.description || '',
        totalFeatures: itemFeatures,
        mappedFeatures: itemMappedFeatures,
        notRequiredFeatures: itemNotRequiredFeatures,
        totalValues: itemValues,
        mappedValues: itemMappedValues,
        fullyMapped: itemFullyMapped,
      });
    });

    const featuresRequiringMapping = totalFeatures - totalNotRequiredFeatures;
    const attributeCoverage = featuresRequiringMapping > 0 ? mappedFeatures / featuresRequiringMapping : 0;
    const valueCoverage = totalValues > 0 ? mappedValues / totalValues : 0;
    const itemCoverage = totalItems > 0 ? itemsFullyMapped / totalItems : 0;

    return {
      totalFeatures,
      mappedFeatures,
      totalValues,
      mappedValues,
      totalItems,
      itemsFullyMapped,
      totalNotRequiredFeatures,
      attributeCoverage,
      valueCoverage,
      itemCoverage,
      perItem,
    };
  }, [bom, mappings, localMappings]);

  const filteredItems = useMemo(() => {
    const q = itemFilter.trim().toLowerCase();
    if (!q) return metrics.perItem;
    return metrics.perItem.filter(
      it => it.itemId.toLowerCase().includes(q) || it.description.toLowerCase().includes(q)
    );
  }, [metrics.perItem, itemFilter]);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
      <div className="bg-slate-50 rounded-2xl shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col border border-slate-200 overflow-hidden">
        <header className="px-6 py-4 border-b border-slate-200 bg-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-indigo-600 text-white shadow-sm">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V9a2 2 0 00-.586-1.414l-4-4A2 2 0 0014.586 3H13a2 2 0 00-2 2z" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-black text-slate-900 tracking-tight">Mapping Health Dashboard</h2>
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-0.5">Snapshot computed on demand</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-all"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <DonutStat
              label="Attribute Mapping Coverage"
              value={metrics.attributeCoverage}
              primaryColor="#22c55e"
              secondaryColor="#e5e7eb"
              description={`${metrics.mappedFeatures.toLocaleString()} of ${(metrics.totalFeatures - metrics.totalNotRequiredFeatures).toLocaleString()} legacy features map to a target attribute (excluding NOT REQUIRED).`}
            />
            <DonutStat
              label="Value Mapping Coverage"
              value={metrics.valueCoverage}
              primaryColor="#6366f1"
              secondaryColor="#e5e7eb"
              description={`${metrics.mappedValues.toLocaleString()} of ${metrics.totalValues.toLocaleString()} legacy values have an explicit mapped value.`}
            />
            <DonutStat
              label="Fully Mapped BOM Items"
              value={metrics.itemCoverage}
              primaryColor="#f97316"
              secondaryColor="#e5e7eb"
              description={`${metrics.itemsFullyMapped.toLocaleString()} of ${metrics.totalItems.toLocaleString()} BOM items have full attribute + value coverage.`}
            />
          </div>

          <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-3 text-[10px] text-slate-600">
            <div className="p-3 rounded-xl bg-white border border-slate-100 shadow-sm">
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Feature Universe</p>
              <p className="font-black text-slate-900 text-sm">{metrics.totalFeatures.toLocaleString()} features</p>
              <p className="mt-0.5 text-[10px] text-slate-500">Across all BOM items in the registry.</p>
            </div>
            <div className="p-3 rounded-xl bg-white border border-slate-100 shadow-sm">
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Legacy Value Universe</p>
              <p className="font-black text-slate-900 text-sm">{metrics.totalValues.toLocaleString()} values</p>
              <p className="mt-0.5 text-[10px] text-slate-500">Every distinct line-level legacy value encountered.</p>
            </div>
            <div className="p-3 rounded-xl bg-white border border-slate-100 shadow-sm">
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">BOM Items Tracked</p>
              <p className="font-black text-slate-900 text-sm">{metrics.totalItems.toLocaleString()} items</p>
              <p className="mt-0.5 text-[10px] text-slate-500">Used to compute fully mapped completion percentage.</p>
            </div>
          </div>

          {/* Per-item breakdown */}
          <div className="rounded-2xl bg-white border border-slate-100 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-3">
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">BOM Item Breakdown</p>
              <input
                type="text"
                value={itemFilter}
                onChange={e => setItemFilter(e.target.value)}
                placeholder="Filter by item ID or description…"
                className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-400 w-64"
              />
            </div>
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="min-w-full text-[11px]">
                <thead className="sticky top-0 bg-slate-50 border-b border-slate-100 z-10">
                  <tr>
                    <th className="px-4 py-2 text-left font-black text-slate-500 uppercase tracking-widest text-[9px] w-40">Item ID</th>
                    <th className="px-4 py-2 text-left font-black text-slate-500 uppercase tracking-widest text-[9px]">Description</th>
                    <th className="px-4 py-2 text-center font-black text-slate-500 uppercase tracking-widest text-[9px]">Attrs</th>
                    <th className="px-4 py-2 text-center font-black text-slate-500 uppercase tracking-widest text-[9px]">Not Req Attrs</th>
                    <th className="px-4 py-2 text-center font-black text-slate-500 uppercase tracking-widest text-[9px]">Values</th>
                    <th className="px-4 py-2 text-center font-black text-slate-500 uppercase tracking-widest text-[9px]">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-slate-400 text-xs">No items match your filter.</td>
                    </tr>
                  ) : filteredItems.map(it => {
                    const mappableAttrs = Math.max(0, it.totalFeatures - it.notRequiredFeatures);
                    const attrPct = mappableAttrs > 0 ? Math.round((it.mappedFeatures / mappableAttrs) * 100) : 100;
                    const valPct = it.totalValues > 0 ? Math.round((it.mappedValues / it.totalValues) * 100) : 100;
                    return (
                      <tr key={it.itemId} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-2 font-mono text-slate-700 font-semibold whitespace-nowrap">{it.itemId}</td>
                        <td className="px-4 py-2 text-slate-600 max-w-xs truncate" title={it.description}>{it.description || '—'}</td>
                        <td className="px-4 py-2 text-center">
                          <span className={`font-bold ${attrPct === 100 ? 'text-green-600' : attrPct >= 50 ? 'text-amber-500' : 'text-red-500'}`}>
                            {it.mappedFeatures}/{mappableAttrs}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-center text-slate-600 font-semibold">
                          {it.notRequiredFeatures}
                        </td>
                        <td className="px-4 py-2 text-center">
                          <span className={`font-bold ${valPct === 100 ? 'text-green-600' : valPct >= 50 ? 'text-amber-500' : 'text-red-500'}`}>
                            {it.totalValues === 0 ? <span className="text-slate-400">—</span> : `${it.mappedValues}/${it.totalValues}`}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-center">
                          {it.fullyMapped ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-black text-[9px] uppercase tracking-widest">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                              Complete
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-black text-[9px] uppercase tracking-widest">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v4m0 4h.01" /></svg>
                              Incomplete
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {itemFilter && (
              <p className="px-4 py-2 text-[10px] text-slate-400 border-t border-slate-50">
                Showing {filteredItems.length} of {metrics.totalItems} items
              </p>
            )}
          </div>
        </div>

        <div className="px-6 py-3 bg-white border-t border-slate-200 flex items-center justify-between text-[9px] text-slate-400">
          <p className="font-black uppercase tracking-widest">Admin Insight • Not real-time • Recompute on demand</p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onRecompute}
              className="px-4 py-1.5 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 font-black uppercase tracking-widest text-[9px] hover:bg-indigo-100 hover:border-indigo-300 transition-all"
            >
              Recompute Snapshot
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-slate-900 text-white font-black uppercase tracking-widest text-[9px] hover:bg-black transition-all"
            >
              Close Dashboard
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MappingDashboard;
