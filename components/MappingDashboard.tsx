import React, { useMemo, useState } from 'react';
import { dbService, DashboardMetricsResponse, DashboardItemMetrics } from '../services/dbService';

interface MappingDashboardProps {
  categories: string[];
  productLines: string[];
  onClose: () => void;
}

interface DonutStatProps {
  label: string;
  value: number;
  primaryColor: string;
  secondaryColor: string;
  description: string;
}

const SELECT_ALL = '__all__';

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

const MappingDashboard: React.FC<MappingDashboardProps> = ({ categories, productLines, onClose }) => {
  const [selectedCategory, setSelectedCategory] = useState(SELECT_ALL);
  const [selectedProductLine, setSelectedProductLine] = useState(SELECT_ALL);
  const [itemFilter, setItemFilter] = useState('');
  const [includeExcluded, setIncludeExcluded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [metrics, setMetrics] = useState<DashboardMetricsResponse | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState('');

  const canCompute = Boolean(selectedCategory) && Boolean(selectedProductLine);

  const filteredItems = useMemo(() => {
    const rows = metrics?.items || [];
    const q = itemFilter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (it: DashboardItemMetrics) =>
        it.itemId.toLowerCase().includes(q) ||
        (it.description || '').toLowerCase().includes(q)
    );
  }, [metrics, itemFilter]);

  const handleCompute = async (forceRecompute = false) => {
    if (!canCompute) return;
    setIsLoading(true);
    setError('');
    setProgress(0);
    setProgressPhase('Connecting to server...');

    // Animate progress phases while waiting
    const phases = [
      { at: 300, pct: 15, label: 'Querying workspace mappings...' },
      { at: 1200, pct: 40, label: 'Aggregating feature stats...' },
      { at: 2500, pct: 65, label: 'Computing coverage metrics...' },
      { at: 4000, pct: 80, label: 'Building item breakdown...' },
    ];
    const timers = phases.map(p =>
      setTimeout(() => { setProgress(p.pct); setProgressPhase(p.label); }, p.at)
    );

    try {
      const category = selectedCategory === SELECT_ALL ? undefined : selectedCategory;
      const productLine = selectedProductLine === SELECT_ALL ? undefined : selectedProductLine;
      const response = await dbService.fetchDashboardMetrics({ category, productLine, includeExcluded, forceRecompute });
      timers.forEach(clearTimeout);
      setProgress(100);
      setProgressPhase('Done');
      setMetrics(response);
    } catch (err: any) {
      timers.forEach(clearTimeout);
      console.warn('Failed to compute dashboard metrics', err);
      setError(err?.message || 'Failed to compute dashboard metrics.');
      setMetrics(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggleIncludeExcluded = async () => {
    const next = !includeExcluded;
    setIncludeExcluded(next);
    if (!canCompute) return;

    setIsLoading(true);
    setError('');
    setProgress(0);
    setProgressPhase('Recalculating with toggle...');

    const timers = [
      setTimeout(() => { setProgress(30); setProgressPhase('Querying workspace mappings...'); }, 200),
      setTimeout(() => { setProgress(60); setProgressPhase('Recomputing metrics...'); }, 800),
    ];

    try {
      const category = selectedCategory === SELECT_ALL ? undefined : selectedCategory;
      const productLine = selectedProductLine === SELECT_ALL ? undefined : selectedProductLine;
      const response = await dbService.fetchDashboardMetrics({ category, productLine, includeExcluded: next });
      timers.forEach(clearTimeout);
      setProgress(100);
      setProgressPhase('Done');
      setMetrics(response);
    } catch (err: any) {
      timers.forEach(clearTimeout);
      console.warn('Failed to compute dashboard metrics', err);
      setError(err?.message || 'Failed to compute dashboard metrics.');
      setMetrics(null);
    } finally {
      setIsLoading(false);
    }
  };

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
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-0.5">Server computed by filters</p>
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

        <div className="px-6 py-4 bg-white border-b border-slate-200">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div>
              <label className="block text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Category</label>
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-300"
              >
                <option value="">Select category...</option>
                <option value={SELECT_ALL}>All Categories</option>
                {categories.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Product Line</label>
              <select
                value={selectedProductLine}
                onChange={(e) => setSelectedProductLine(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-300"
              >
                <option value="">Select product line...</option>
                <option value={SELECT_ALL}>All Product Lines</option>
                {productLines.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </div>

            <div className="flex justify-start md:justify-end gap-2">
              <button
                type="button"
                disabled={!canCompute || isLoading}
                onClick={() => handleCompute(false)}
                className={`px-4 py-2 rounded-lg border font-black uppercase tracking-widest text-[10px] transition-all ${
                  !canCompute || isLoading
                    ? 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 hover:border-indigo-300'
                }`}
              >
                {isLoading ? 'Computing...' : 'Compute'}
              </button>
              {metrics && (
                <button
                  type="button"
                  disabled={!canCompute || isLoading}
                  onClick={() => handleCompute(true)}
                  className={`px-4 py-2 rounded-lg border font-black uppercase tracking-widest text-[10px] transition-all ${
                    !canCompute || isLoading
                      ? 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed'
                      : 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 hover:border-amber-300'
                  }`}
                >
                  Recompute
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {!metrics && !isLoading && !error && (
            <div className="rounded-xl border border-slate-200 bg-white p-6 text-center">
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">No data loaded</p>
              <p className="mt-1 text-[11px] text-slate-500">Select Category and Product Line, then click Compute.</p>
            </div>
          )}

          {isLoading && (
            <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{progressPhase || 'Computing...'}</p>
                <span className="text-[10px] font-black text-indigo-600">{progress}%</span>
              </div>
              <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${Math.max(progress, 5)}%` }}
                />
              </div>
            </div>
          )}

          {error && !isLoading && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
              <p className="text-[10px] font-black text-rose-700 uppercase tracking-widest">Failed</p>
              <p className="mt-1 text-[11px] text-rose-700">{error}</p>
            </div>
          )}

          {metrics && !isLoading && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <DonutStat
                  label="Attribute Mapping Coverage"
                  value={metrics.coverage.attribute}
                  primaryColor="#22c55e"
                  secondaryColor="#e5e7eb"
                  description={`${metrics.mapped.features.toLocaleString()} mapped features (excluding NOT REQUIRED from denominator).`}
                />
                <DonutStat
                  label="Value Mapping Coverage"
                  value={metrics.coverage.value}
                  primaryColor="#6366f1"
                  secondaryColor="#e5e7eb"
                  description={`${metrics.mapped.values.toLocaleString()} of ${metrics.totals.values.toLocaleString()} values mapped.`}
                />
                <DonutStat
                  label="Fully Mapped BOM Items"
                  value={metrics.coverage.item}
                  primaryColor="#f97316"
                  secondaryColor="#e5e7eb"
                  description={`${metrics.mapped.items.toLocaleString()} of ${metrics.totals.items.toLocaleString()} BOM items complete.`}
                />
              </div>

              {metrics.excluded.features > 0 && (
                <div className="flex items-center gap-3 px-1">
                  <button
                    type="button"
                    onClick={handleToggleIncludeExcluded}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-[9px] font-black uppercase tracking-widest transition-all ${
                      includeExcluded
                        ? 'bg-amber-600 border-amber-500 text-white shadow-sm'
                        : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    <span>{includeExcluded ? 'Excluded Attrs in Calc' : 'Excluded Attrs Ignored'}</span>
                  </button>
                  <span className="text-[9px] text-slate-400 font-medium">
                    {metrics.excluded.features} excluded attribute{metrics.excluded.features === 1 ? '' : 's'} ({metrics.excluded.values} value{metrics.excluded.values === 1 ? '' : 's'}) from unchecked categories
                  </span>
                </div>
              )}

              <div className="rounded-2xl bg-white border border-slate-100 shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-3">
                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">BOM Item Breakdown</p>
                  <input
                    type="text"
                    value={itemFilter}
                    onChange={e => setItemFilter(e.target.value)}
                    placeholder="Filter by item ID or description..."
                    className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-400 w-64"
                  />
                </div>

                <div className="overflow-x-auto max-h-80 overflow-y-auto">
                  <table className="min-w-full text-[11px]">
                    <thead className="sticky top-0 bg-slate-50 border-b border-slate-100 z-10">
                      <tr>
                        <th className="px-4 py-2 text-left font-black text-slate-500 uppercase tracking-widest text-[9px] w-40">Item ID</th>
                        <th className="px-4 py-2 text-left font-black text-slate-500 uppercase tracking-widest text-[9px]">Description</th>
                        <th className="px-4 py-2 text-left font-black text-slate-500 uppercase tracking-widest text-[9px]">Category</th>
                        <th className="px-4 py-2 text-left font-black text-slate-500 uppercase tracking-widest text-[9px]">Product Line</th>
                        <th className="px-4 py-2 text-center font-black text-slate-500 uppercase tracking-widest text-[9px]">Attrs</th>
                        <th className="px-4 py-2 text-center font-black text-slate-500 uppercase tracking-widest text-[9px]">Not Req</th>
                        <th className="px-4 py-2 text-center font-black text-slate-500 uppercase tracking-widest text-[9px]">Excluded</th>
                        <th className="px-4 py-2 text-center font-black text-slate-500 uppercase tracking-widest text-[9px]">Values</th>
                        <th className="px-4 py-2 text-center font-black text-slate-500 uppercase tracking-widest text-[9px]">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="px-4 py-6 text-center text-slate-400 text-xs">No items match your filter.</td>
                        </tr>
                      ) : filteredItems.map((it) => {
                        const mappableAttrs = Math.max(0, it.totalFeatures - it.notRequiredFeatures);
                        const attrPct = mappableAttrs > 0 ? Math.round((it.mappedFeatures / mappableAttrs) * 100) : 100;
                        const valPct = it.totalValues > 0 ? Math.round((it.mappedValues / it.totalValues) * 100) : 100;
                        return (
                          <tr key={it.itemId} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                            <td className="px-4 py-2 font-mono text-slate-700 font-semibold whitespace-nowrap">{it.itemId}</td>
                            <td className="px-4 py-2 text-slate-600 max-w-xs truncate" title={it.description}>{it.description || '—'}</td>
                            <td className="px-4 py-2 text-slate-600 whitespace-nowrap">{it.category || '—'}</td>
                            <td className="px-4 py-2 text-slate-600 whitespace-nowrap">{it.productType || '—'}</td>
                            <td className="px-4 py-2 text-center">
                              <span className={`font-bold ${attrPct === 100 ? 'text-green-600' : attrPct >= 50 ? 'text-amber-500' : 'text-red-500'}`}>
                                {it.mappedFeatures}/{mappableAttrs}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-center text-slate-600 font-semibold">{it.notRequiredFeatures}</td>
                            <td className="px-4 py-2 text-center text-slate-600 font-semibold">{it.excludedFeatures || 0}</td>
                            <td className="px-4 py-2 text-center">
                              <span className={`font-bold ${valPct === 100 ? 'text-green-600' : valPct >= 50 ? 'text-amber-500' : 'text-red-500'}`}>
                                {it.totalValues === 0 ? <span className="text-slate-400">—</span> : `${it.mappedValues}/${it.totalValues}`}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-center">
                              {it.fullyMapped ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-black text-[9px] uppercase tracking-widest">
                                  Complete
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-black text-[9px] uppercase tracking-widest">
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
                    Showing {filteredItems.length} of {metrics.totals.items} items
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-3 bg-white border-t border-slate-200 flex items-center justify-between text-[9px] text-slate-400">
          <p className="font-black uppercase tracking-widest">Server-side Snapshot • Filtered by category and product line</p>
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
  );
};

export default MappingDashboard;
