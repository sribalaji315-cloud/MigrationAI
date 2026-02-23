import React, { useMemo } from 'react';
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
    let totalValues = 0;
    let mappedValues = 0;
    const totalItems = bom.length;
    let itemsFullyMapped = 0;

    bom.forEach(item => {
      const localForItem = localMappings[item.itemId] || [];
      let itemFeatures = 0;
      let itemMappedFeatures = 0;
      let itemValues = 0;
      let itemMappedValues = 0;

      item.features.forEach(feature => {
        totalFeatures += 1;
        itemFeatures += 1;

        const localMapping = localForItem.find(m => (m.legacyFeatureIds || []).includes(feature.featureId));
        const globalMapping = globalByFeature[feature.featureId];
        const effective = localMapping || globalMapping || null;

        const attributeMapped = !!(
          effective &&
          effective.newAttributeId &&
          effective.newAttributeId.toUpperCase() !== 'UNMAPPED'
        );

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

      const itemFullyMapped =
        itemFeatures > 0 &&
        itemValues > 0 &&
        itemFeatures === itemMappedFeatures &&
        itemValues === itemMappedValues;

      if (itemFullyMapped) {
        itemsFullyMapped += 1;
      }
    });

    const attributeCoverage = totalFeatures > 0 ? mappedFeatures / totalFeatures : 0;
    const valueCoverage = totalValues > 0 ? mappedValues / totalValues : 0;
    const itemCoverage = totalItems > 0 ? itemsFullyMapped / totalItems : 0;

    return {
      totalFeatures,
      mappedFeatures,
      totalValues,
      mappedValues,
      totalItems,
      itemsFullyMapped,
      attributeCoverage,
      valueCoverage,
      itemCoverage,
    };
  }, [bom, mappings, localMappings]);

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
              description={`${metrics.mappedFeatures.toLocaleString()} of ${metrics.totalFeatures.toLocaleString()} legacy features have a target attribute.`}
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
