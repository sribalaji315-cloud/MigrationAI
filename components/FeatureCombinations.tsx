import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { User, FeatureCombinationJobProgress, FeatureCombinationRow, FeatureCombinationItem } from '../types';
import { dbService } from '../services/dbService';

interface FeatureCombinationsProps {
  currentUser: User;
  onClose: () => void;
}

const PAGE_SIZE = 20;
const MIN_LEFT_W = 300;
const MIN_RIGHT_W = 260;

/* ---------- Multi-select searchable dropdown ---------- */
interface MultiSelectProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (vals: string[]) => void;
}

const MultiSelectDropdown: React.FC<MultiSelectProps> = ({ label, options, selected, onChange }) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const filtered = useMemo(() => {
    if (!search) return options;
    const lower = search.toLowerCase();
    return options.filter(o => o.toLowerCase().includes(lower));
  }, [options, search]);

  const toggle = (val: string) => {
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);
  };

  const displayText = selected.length === 0 ? label : selected.length === 1 ? selected[0] : `${selected.length} selected`;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 px-2 py-1.5 border border-slate-200 rounded-md text-xs bg-white hover:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 min-w-[110px] max-w-[180px]"
      >
        <span className="truncate flex-1 text-left">{displayText}</span>
        <svg className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {selected.length > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onChange([]); }}
          className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-slate-400 text-white rounded-full text-[8px] font-bold flex items-center justify-center hover:bg-red-500 z-20"
        >×</button>
      )}
      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-white border border-slate-200 rounded-md shadow-lg z-30 max-h-64 flex flex-col">
          <div className="p-1.5 border-b border-slate-100">
            <input
              type="text"
              placeholder="Search…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full px-2 py-1 border border-slate-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
              autoFocus
            />
          </div>
          <div className="flex-1 overflow-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-slate-400">No matches</div>
            ) : filtered.map(o => (
              <label key={o} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={selected.includes(o)}
                  onChange={() => toggle(o)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-400"
                />
                <span className="truncate">{o}</span>
              </label>
            ))}
          </div>
          {selected.length > 0 && (
            <div className="p-1.5 border-t border-slate-100">
              <button onClick={() => onChange([])} className="text-[9px] text-blue-600 hover:text-blue-800 font-bold uppercase tracking-wider">Clear all</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const FeatureCombinations: React.FC<FeatureCombinationsProps> = ({ currentUser, onClose }) => {
  // Job state
  const [jobProgress, setJobProgress] = useState<FeatureCombinationJobProgress | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Summary list state
  const [rows, setRows] = useState<FeatureCombinationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Filter state
  const [filterFeatureIds, setFilterFeatureIds] = useState<string[]>([]);
  const [filterAttributeTypes, setFilterAttributeTypes] = useState<string[]>([]);
  const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
  const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
  const [filterOptions, setFilterOptions] = useState<{ featureIds: string[]; attributeTypes: string[]; priorities: number[]; statuses: string[] }>({ featureIds: [], attributeTypes: [], priorities: [], statuses: [] });

  // Sort state
  const [sortBy, setSortBy] = useState<string | undefined>(undefined);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Selected combo detail state
  const [selectedCombo, setSelectedCombo] = useState<FeatureCombinationRow | null>(null);
  const [comboItems, setComboItems] = useState<FeatureCombinationItem[]>([]);
  const [isLoadingItems, setIsLoadingItems] = useState(false);

  // Resizable panel state
  const containerRef = useRef<HTMLDivElement>(null);
  const [rightPanelWidth, setRightPanelWidth] = useState(380);
  const draggingRef = useRef(false);

  // --- Resize handlers ---
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startW = rightPanelWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const containerW = containerRef.current.getBoundingClientRect().width;
      const delta = startX - ev.clientX;
      const newRight = Math.max(MIN_RIGHT_W, Math.min(containerW - MIN_LEFT_W, startW + delta));
      setRightPanelWidth(newRight);
    };

    const onMouseUp = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [rightPanelWidth]);

  // --- Fetch filter options ---
  const loadFilters = useCallback(async () => {
    try {
      const f = await dbService.fetchFeatureCombinationFilters();
      setFilterOptions(f);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { loadFilters(); }, [loadFilters]);

  // --- Job polling ---
  const pollProgress = useCallback(async () => {
    try {
      const p = await dbService.fetchFeatureCombinationProgress();
      setJobProgress(p);
      const isActive = p.status === 'queued' || p.status === 'running';
      const waitMs = isActive ? 2000 : 10000;
      pollRef.current = setTimeout(pollProgress, waitMs);
    } catch {
      pollRef.current = setTimeout(pollProgress, 10000);
    }
  }, []);

  useEffect(() => {
    pollProgress();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [pollProgress]);

  // Auto-refresh list + filters after job completes
  const prevStatusRef = useRef<string | undefined>();
  useEffect(() => {
    if (prevStatusRef.current === 'running' && jobProgress?.status === 'completed') {
      fetchList(0, search, filterFeatureIds, filterAttributeTypes, filterPriorities, filterStatuses, sortBy, sortDir);
      loadFilters();
    }
    prevStatusRef.current = jobProgress?.status;
  }, [jobProgress?.status]);

  // --- Trigger job ---
  const handleTrigger = useCallback(async () => {
    setIsTriggering(true);
    try {
      await dbService.triggerFeatureCombinationBuild();
      const p = await dbService.fetchFeatureCombinationProgress();
      setJobProgress(p);
    } catch (err: any) {
      console.error('trigger failed', err);
    } finally {
      setIsTriggering(false);
    }
  }, []);

  // --- Fetch summary list ---
  const fetchList = useCallback(async (pageNum: number, searchTerm: string, featIds: string[], attrTypes: string[], prios: string[], statuses: string[], sBy?: string, sDir?: string) => {
    setIsLoading(true);
    try {
      const result = await dbService.fetchFeatureCombinations({
        search: searchTerm || undefined,
        featureId: featIds.length ? featIds.join(',') : undefined,
        attributeType: attrTypes.length ? attrTypes.join(',') : undefined,
        priority: prios.length === 1 ? Number(prios[0]) : undefined,
        status: statuses.length ? statuses.join(',') : undefined,
        sortBy: sBy || undefined,
        sortDir: sDir || undefined,
        limit: PAGE_SIZE,
        offset: pageNum * PAGE_SIZE,
      });
      setRows(result.items);
      setTotal(result.total);
    } catch (err: any) {
      console.error('fetch list failed', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchList(page, search, filterFeatureIds, filterAttributeTypes, filterPriorities, filterStatuses, sortBy, sortDir); }, [page, search, filterFeatureIds, filterAttributeTypes, filterPriorities, filterStatuses, sortBy, sortDir, fetchList]);

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(0);
    setSelectedCombo(null);
    setComboItems([]);
  };

  const handleMultiFilterChange = (setter: (v: string[]) => void) => (vals: string[]) => {
    setter(vals);
    setPage(0);
    setSelectedCombo(null);
    setComboItems([]);
  };

  // --- Select a combo row ---
  const handleSelectCombo = useCallback(async (combo: FeatureCombinationRow) => {
    if (selectedCombo?.id === combo.id) {
      setSelectedCombo(null);
      setComboItems([]);
      return;
    }
    setSelectedCombo(combo);
    setIsLoadingItems(true);
    try {
      const result = await dbService.fetchFeatureCombinationItems(combo.id);
      setComboItems(result.items);
    } catch (err: any) {
      console.error('fetch items failed', err);
      setComboItems([]);
    } finally {
      setIsLoadingItems(false);
    }
  }, [selectedCombo]);

  // --- Derived ---
  const isActive = jobProgress?.status === 'queued' || jobProgress?.status === 'running';
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasPriorityFilter = filterPriorities.length === 1;

  const handleSort = (col: string) => {
    if (sortBy === col) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
    setPage(0);
  };

  const sortArrow = (col: string) => sortBy === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  const statusColor = (() => {
    switch (jobProgress?.status) {
      case 'queued': case 'running': return 'text-amber-600';
      case 'completed': return 'text-emerald-600';
      case 'failed': return 'text-rose-600';
      default: return 'text-slate-400';
    }
  })();

  return (
    <div className="fixed inset-0 z-50 bg-slate-50 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-black text-slate-800 uppercase tracking-wider">Feature Combinations</h1>
          {jobProgress && (
            <span className={`text-[9px] font-black uppercase tracking-wider ${statusColor}`}>
              {jobProgress.status === 'running'
                ? `Building ${Math.round(jobProgress.progress * 100)}%`
                : jobProgress.status}
              {jobProgress.status === 'completed' && jobProgress.generatedRows != null &&
                ` — ${jobProgress.generatedRows.toLocaleString()} combinations`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleTrigger}
            disabled={isActive || isTriggering}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-md text-[9px] font-black uppercase tracking-wider hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {isActive ? (
              <>
                <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Building…
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Build Combinations
              </>
            )}
          </button>
          <button
            onClick={onClose}
            className="flex items-center gap-1 px-3 py-1.5 bg-slate-100 text-slate-600 rounded-md text-[9px] font-black uppercase tracking-wider hover:bg-slate-200 transition-all"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            Close
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {isActive && (
        <div className="w-full h-1 bg-slate-200 shrink-0">
          <div
            className="h-full bg-blue-500 transition-all duration-500"
            style={{ width: `${Math.round((jobProgress?.progress ?? 0) * 100)}%` }}
          />
        </div>
      )}

      {/* Search + Filters */}
      <div className="px-5 py-2 bg-white border-b border-slate-100 flex items-center gap-2 shrink-0 flex-wrap">
        <input
          type="text"
          placeholder="Search by feature ID, description, or values…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
          className="flex-1 min-w-[180px] px-3 py-1.5 border border-slate-200 rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <button
          onClick={handleSearch}
          className="px-3 py-1.5 bg-slate-100 text-slate-600 rounded-md text-[9px] font-black uppercase tracking-wider hover:bg-slate-200 transition-all"
        >
          Search
        </button>
        <div className="h-4 w-px bg-slate-200" />
        <MultiSelectDropdown
          label="All Features"
          options={filterOptions.featureIds}
          selected={filterFeatureIds}
          onChange={handleMultiFilterChange(setFilterFeatureIds)}
        />
        <MultiSelectDropdown
          label="All Attr Types"
          options={filterOptions.attributeTypes}
          selected={filterAttributeTypes}
          onChange={handleMultiFilterChange(setFilterAttributeTypes)}
        />
        <MultiSelectDropdown
          label="All Priorities"
          options={filterOptions.priorities.map(String)}
          selected={filterPriorities}
          onChange={handleMultiFilterChange(setFilterPriorities)}
        />
        <MultiSelectDropdown
          label="All Statuses"
          options={filterOptions.statuses}
          selected={filterStatuses}
          onChange={handleMultiFilterChange(setFilterStatuses)}
        />
        <span className="text-[9px] text-slate-400 font-medium ml-auto">{total.toLocaleString()} combinations</span>
      </div>

      {/* Content: resizable split */}
      <div ref={containerRef} className="flex flex-1 overflow-hidden">
        {/* Left: Summary table */}
        <div className="flex flex-col overflow-hidden" style={{ width: `calc(100% - ${rightPanelWidth}px)`, minWidth: MIN_LEFT_W }}>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr>
                  <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Feature / Attribute</th>
                  <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Attr Type</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('legacyValueCount')}># Values{sortArrow('legacyValueCount')}</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('comboCountForFeature')}>Combos{sortArrow('comboCountForFeature')}</th>
                  <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Legacy Values</th>
                  <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">D365 Attribute &amp; Values</th>
                  <th className="text-center px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Status</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('itemCount')}>Items{sortArrow('itemCount')}</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={8} className="text-center py-8">
                      <div className="flex items-center justify-center gap-2 text-slate-400">
                        <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        Loading…
                      </div>
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-8 text-slate-400">
                      {total === 0 ? 'No combinations built yet. Click "Build Combinations" to start.' : 'No matches found.'}
                    </td>
                  </tr>
                ) : rows.map(r => {
                  const d365Entries = Object.entries(r.d365Values || {});
                  const statusColor = r.mappingStatus === 'complete' ? 'bg-emerald-100 text-emerald-700' : r.mappingStatus === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500';
                  return (
                  <tr
                    key={r.id}
                    onClick={() => handleSelectCombo(r)}
                    className={`cursor-pointer border-b border-slate-100 transition-colors ${
                      selectedCombo?.id === r.id
                        ? 'bg-blue-50 hover:bg-blue-100'
                        : 'hover:bg-slate-50'
                    }`}
                  >
                    <td className="px-3 py-2">
                      <div className="font-semibold text-slate-800">{r.featureId}</div>
                      {r.description && <div className="text-[10px] text-slate-400 truncate max-w-[200px]">{r.description}</div>}
                      {r.unit && <div className="text-[10px] text-slate-400">Unit: {r.unit}</div>}
                    </td>
                    <td className="px-3 py-2">
                      {r.attributeType ? (
                        <span className="inline-block px-1.5 py-0.5 bg-teal-50 text-teal-700 rounded text-[10px] font-medium">{r.attributeType}</span>
                      ) : (
                        <span className="text-[10px] text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className="inline-flex items-center justify-center min-w-[24px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[10px] font-bold">
                        {r.legacyValueCount}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className="inline-flex items-center justify-center min-w-[24px] px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 text-[10px] font-bold">
                        {r.comboCountForFeature}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1 max-w-[300px]">
                        {r.normalizedValues.slice(0, 6).map((v, i) => (
                          <span key={i} className="inline-block px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-medium">{v}</span>
                        ))}
                        {r.normalizedValues.length > 6 && (
                          <span className="inline-block px-1.5 py-0.5 bg-slate-200 text-slate-500 rounded text-[10px] font-medium">
                            +{r.normalizedValues.length - 6} more
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {r.d365AttributeId ? (
                        <div>
                          <div className="font-semibold text-indigo-700 text-[10px] mb-0.5">{r.d365AttributeId}</div>
                          <div className="flex flex-wrap gap-1 max-w-[280px]">
                            {d365Entries.slice(0, 4).map(([lv, dv]) => (
                              <span key={lv} className="inline-block px-1 py-0.5 bg-indigo-50 text-indigo-600 rounded text-[9px]" title={`${lv} → ${dv}`}>
                                {lv}→{dv}
                              </span>
                            ))}
                            {d365Entries.length > 4 && (
                              <span className="inline-block px-1 py-0.5 bg-indigo-100 text-indigo-500 rounded text-[9px]">
                                +{d365Entries.length - 4}
                              </span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-[10px] text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${statusColor}`}>
                        {r.mappingStatus === 'complete'
                          ? (r.legacyValueCount === 0 ? '✓ attr' : `✓ ${r.mappedValueCount}/${r.legacyValueCount}`)
                          : r.mappingStatus === 'partial' ? `${r.mappedValueCount}/${r.legacyValueCount}` : 'unmapped'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {hasPriorityFilter && r.filteredItemCount != null ? (
                        <span className="inline-flex items-center justify-center min-w-[28px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold" title={`${r.filteredItemCount} of ${r.itemCount} items match P${filterPriorities[0]}`}>
                          {r.filteredItemCount}<span className="text-[8px] text-amber-500 ml-0.5">/{r.itemCount}</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center justify-center min-w-[28px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold">
                          {r.itemCount}
                        </span>
                      )}
                      {r.priorities && r.priorities.length > 0 && (
                        <div className="mt-0.5 flex justify-end gap-0.5">
                          {r.priorities.slice(0, 3).map((p, i) => (
                            <span key={i} className="inline-block px-1 py-0 bg-amber-50 text-amber-600 rounded text-[8px] font-bold">P{p}</span>
                          ))}
                          {r.priorities.length > 3 && <span className="text-[8px] text-slate-400">+{r.priorities.length - 3}</span>}
                        </div>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-3 py-2 bg-white border-t border-slate-200 shrink-0">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-2 py-1 text-[9px] font-bold text-slate-500 bg-slate-100 rounded hover:bg-slate-200 disabled:opacity-40"
              >
                ← Prev
              </button>
              <span className="text-[9px] text-slate-400 font-medium">
                Page {page + 1} of {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-2 py-1 text-[9px] font-bold text-slate-500 bg-slate-100 rounded hover:bg-slate-200 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          )}
        </div>

        {/* Drag handle */}
        <div
          onMouseDown={handleMouseDown}
          className="w-1.5 cursor-col-resize bg-slate-200 hover:bg-blue-400 active:bg-blue-500 transition-colors shrink-0"
        />

        {/* Right: Items panel */}
        <div style={{ width: rightPanelWidth, minWidth: MIN_RIGHT_W }} className="flex flex-col overflow-hidden bg-white shrink-0">
          <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50 shrink-0">
            <h2 className="text-[9px] font-black uppercase tracking-wider text-slate-500">
              {selectedCombo
                ? `Items using ${selectedCombo.featureId} — ${selectedCombo.normalizedValues.length} value${selectedCombo.normalizedValues.length !== 1 ? 's' : ''}`
                : 'Select a combination to view items'}
            </h2>
          </div>
          <div className="flex-1 overflow-auto">
            {!selectedCombo ? (
              <div className="flex items-center justify-center h-full text-slate-300 text-xs">
                <div className="text-center">
                  <svg className="w-8 h-8 mx-auto mb-2 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  Click a row to see matching items
                </div>
              </div>
            ) : isLoadingItems ? (
              <div className="flex items-center justify-center h-32">
                <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : comboItems.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-xs">No items found</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-slate-50 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Item ID</th>
                    <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Description</th>
                    <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Category</th>
                    <th className="text-center px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Priority</th>
                    <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Product Line</th>
                  </tr>
                </thead>
                <tbody>
                  {comboItems.map(item => (
                    <tr key={item.itemId} className="border-b border-slate-50 hover:bg-slate-50">
                      <td className="px-3 py-1.5 font-semibold text-slate-700">{item.itemId}</td>
                      <td className="px-3 py-1.5 text-slate-500 truncate max-w-[160px]">{item.description}</td>
                      <td className="px-3 py-1.5 text-slate-400">{item.category}</td>
                      <td className="px-3 py-1.5 text-center">
                        {item.priority != null ? (
                          <span className="inline-block px-1.5 py-0.5 bg-amber-50 text-amber-600 rounded text-[10px] font-bold">P{item.priority}</span>
                        ) : (
                          <span className="text-[10px] text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-slate-400">{item.productType || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {selectedCombo && comboItems.length > 0 && (
            <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 shrink-0">
              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">
                {comboItems.length} item{comboItems.length !== 1 ? 's' : ''}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default FeatureCombinations;
