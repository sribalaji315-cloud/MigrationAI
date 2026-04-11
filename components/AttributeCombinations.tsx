import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { User, AttributeCombinationJobProgress, AttributeCombinationRow, AttributeCombinationItem, AttrComboConsolidationAnalysis } from '../types';
import { dbService } from '../services/dbService';

interface AttributeCombinationsProps {
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

const AttributeCombinations: React.FC<AttributeCombinationsProps> = ({ currentUser, onClose }) => {
  // Job state
  const [jobProgress, setJobProgress] = useState<AttributeCombinationJobProgress | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Summary list state
  const [rows, setRows] = useState<AttributeCombinationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Filter state
  const [filterCategories, setFilterCategories] = useState<string[]>([]);
  const [filterProductTypes, setFilterProductTypes] = useState<string[]>([]);
  const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
  const [filterAttributeTypes, setFilterAttributeTypes] = useState<string[]>([]);
  const [filterOptions, setFilterOptions] = useState<{ categories: string[]; productTypes: string[]; priorities: number[]; attributeTypes: string[]; availableAttributeTypes: string[] }>({ categories: [], productTypes: [], priorities: [], attributeTypes: [], availableAttributeTypes: [] });

  // Build-time attribute type selection
  const [selectedBuildAttrTypes, setSelectedBuildAttrTypes] = useState<string[]>([]);

  // Sort state
  const [sortBy, setSortBy] = useState<string | undefined>(undefined);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Selected combo detail state
  const [selectedCombo, setSelectedCombo] = useState<AttributeCombinationRow | null>(null);
  const [comboItems, setComboItems] = useState<AttributeCombinationItem[]>([]);
  const [isLoadingItems, setIsLoadingItems] = useState(false);

  // Analysis mode
  const [analysisMode, setAnalysisMode] = useState(false);
  const [rightTab, setRightTab] = useState<'items' | 'consolidate'>('items');
  const [consolidation, setConsolidation] = useState<AttrComboConsolidationAnalysis | null>(null);
  const [isLoadingConsolidation, setIsLoadingConsolidation] = useState(false);

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
      const f = await dbService.fetchAttributeCombinationFilters();
      setFilterOptions(f);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { loadFilters(); }, [loadFilters]);

  // --- Job polling ---
  const pollProgress = useCallback(async () => {
    try {
      const p = await dbService.fetchAttributeCombinationProgress();
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
  const prevStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevStatusRef.current === 'running' && jobProgress?.status === 'completed') {
      fetchList(0, search, filterCategories, filterProductTypes, filterPriorities, filterAttributeTypes, sortBy, sortDir, analysisMode);
      loadFilters();
    }
    prevStatusRef.current = jobProgress?.status;
  }, [jobProgress?.status]);

  // --- Trigger job ---
  const handleTrigger = useCallback(async () => {
    setIsTriggering(true);
    try {
      await dbService.triggerAttributeCombinationBuild(selectedBuildAttrTypes.length > 0 ? selectedBuildAttrTypes : undefined);
      const p = await dbService.fetchAttributeCombinationProgress();
      setJobProgress(p);
    } catch (err: any) {
      console.error('trigger failed', err);
    } finally {
      setIsTriggering(false);
    }
  }, [selectedBuildAttrTypes]);

  // Sync selected build types from last job progress
  useEffect(() => {
    if (jobProgress?.selectedAttributeTypes && selectedBuildAttrTypes.length === 0) {
      setSelectedBuildAttrTypes(jobProgress.selectedAttributeTypes);
    }
  }, [jobProgress?.selectedAttributeTypes]);

  // --- Fetch summary list ---
  const fetchList = useCallback(async (pageNum: number, searchTerm: string, categories: string[], productTypes: string[], prios: string[], attrTypes: string[], sBy?: string, sDir?: string, analysis?: boolean) => {
    setIsLoading(true);
    try {
      const result = await dbService.fetchAttributeCombinations({
        search: searchTerm || undefined,
        category: categories.length ? categories.join(',') : undefined,
        productType: productTypes.length ? productTypes.join(',') : undefined,
        priority: prios.length === 1 ? Number(prios[0]) : undefined,
        attributeType: attrTypes.length ? attrTypes.join(',') : undefined,
        sortBy: sBy || undefined,
        sortDir: sDir || undefined,
        analysisMode: analysis || undefined,
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

  useEffect(() => { fetchList(page, search, filterCategories, filterProductTypes, filterPriorities, filterAttributeTypes, sortBy, sortDir, analysisMode); }, [page, search, filterCategories, filterProductTypes, filterPriorities, filterAttributeTypes, sortBy, sortDir, analysisMode, fetchList]);

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
  const handleSelectCombo = useCallback(async (combo: AttributeCombinationRow) => {
    if (selectedCombo?.id === combo.id) {
      setSelectedCombo(null);
      setComboItems([]);
      return;
    }
    setSelectedCombo(combo);
    setConsolidation(null);
    if (analysisMode) {
      setRightTab('consolidate');
    } else {
      setRightTab('items');
    }
    setIsLoadingItems(true);
    try {
      const result = await dbService.fetchAttributeCombinationItems(combo.id);
      setComboItems(result.items);
    } catch (err: any) {
      console.error('fetch items failed', err);
      setComboItems([]);
    } finally {
      setIsLoadingItems(false);
    }
  }, [selectedCombo, analysisMode]);

  // --- Toggle analysis mode ---
  const handleToggleAnalysisMode = useCallback(() => {
    setAnalysisMode(prev => {
      const next = !prev;
      setPage(0);
      setSelectedCombo(null);
      setComboItems([]);
      setConsolidation(null);
      setRightTab(next ? 'consolidate' : 'items');
      return next;
    });
  }, []);

  // --- Fetch consolidation analysis on demand ---
  const handleConsolidateClick = useCallback(() => {
    if (!selectedCombo) return;
    setRightTab('consolidate');
    if (consolidation && consolidation.comboId === selectedCombo.id) return;
    setIsLoadingConsolidation(true);
    setConsolidation(null);
    dbService.fetchAttrComboConsolidationAnalysis(selectedCombo.id)
      .then(data => setConsolidation(data))
      .catch(err => { console.error('consolidation fetch failed', err); setConsolidation(null); })
      .finally(() => setIsLoadingConsolidation(false));
  }, [selectedCombo, consolidation]);

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
          <h1 className="text-sm font-black text-slate-800 uppercase tracking-wider">Attribute Combinations</h1>
          {jobProgress && (
            <span className={`text-[9px] font-black uppercase tracking-wider ${statusColor}`}>
              {jobProgress.status === 'running'
                ? `Building ${Math.round(jobProgress.progress * 100)}%`
                : jobProgress.status}
              {jobProgress.status === 'completed' && jobProgress.generatedRows != null &&
                ` — ${jobProgress.generatedRows.toLocaleString()} configurations`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Analysis Mode toggle */}
          <button
            onClick={handleToggleAnalysisMode}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[9px] font-black uppercase tracking-wider transition-all ${
              analysisMode
                ? 'bg-violet-600 text-white hover:bg-violet-700'
                : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            {analysisMode ? 'Analysis ON' : 'Analysis'}
          </button>
          <div className="h-4 w-px bg-slate-200" />
          {filterOptions.availableAttributeTypes.length > 0 && (
            <MultiSelectDropdown
              label="Attr Types to Build"
              options={filterOptions.availableAttributeTypes}
              selected={selectedBuildAttrTypes}
              onChange={setSelectedBuildAttrTypes}
            />
          )}
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
                Build Analysis
              </>
            )}
          </button>
          <div className="h-4 w-px bg-slate-200" />
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

      {/* Progress panel */}
      {isActive && jobProgress && (
        <div className="px-5 py-3 bg-gradient-to-r from-blue-50 to-indigo-50 border-b border-blue-200 shrink-0">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs font-bold text-blue-700">
                {jobProgress.status === 'queued' ? 'Queued — waiting to start…' : `Building attribute combinations…`}
              </span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-blue-600 font-medium">
              <span>{jobProgress.processedItems.toLocaleString()} / {jobProgress.totalItems.toLocaleString()} items</span>
              <span className="font-black">{Math.round(jobProgress.progress * 100)}%</span>
            </div>
          </div>
          <div className="w-full h-2 bg-blue-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 rounded-full transition-all duration-700 ease-out"
              style={{ width: `${Math.max(2, Math.round(jobProgress.progress * 100))}%` }}
            />
          </div>
          <div className="mt-1 text-[9px] text-blue-400 font-medium">
            Running in background — you can browse existing results while the build completes
          </div>
        </div>
      )}

      {/* Search + Filters */}
      <div className="px-5 py-2 bg-white border-b border-slate-100 flex items-center gap-2 shrink-0 flex-wrap">
        <input
          type="text"
          placeholder="Search attributes…"
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
          label="All Categories"
          options={filterOptions.categories}
          selected={filterCategories}
          onChange={handleMultiFilterChange(setFilterCategories)}
        />
        <MultiSelectDropdown
          label="All Product Types"
          options={filterOptions.productTypes}
          selected={filterProductTypes}
          onChange={handleMultiFilterChange(setFilterProductTypes)}
        />
        <MultiSelectDropdown
          label="All Priorities"
          options={filterOptions.priorities.map(String)}
          selected={filterPriorities}
          onChange={handleMultiFilterChange(setFilterPriorities)}
        />
        {filterOptions.attributeTypes.length > 0 && (
          <MultiSelectDropdown
            label="All Attr Types"
            options={filterOptions.attributeTypes}
            selected={filterAttributeTypes}
            onChange={handleMultiFilterChange(setFilterAttributeTypes)}
          />
        )}
        <span className="text-[9px] text-slate-400 font-medium ml-auto">
          {total.toLocaleString()} {analysisMode ? 'fingerprints with overlaps' : 'combinations'}
          {analysisMode && <span className="ml-1 text-violet-500">(analysis mode)</span>}
        </span>
      </div>

      {/* Content: resizable split */}
      <div ref={containerRef} className="flex flex-1 overflow-hidden">
        {/* Left: Summary table */}
        <div className="flex flex-col overflow-hidden" style={{ width: `calc(100% - ${rightPanelWidth}px)`, minWidth: MIN_LEFT_W }}>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('featureCount')}># Attrs{sortArrow('featureCount')}</th>
                  <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Attribute Set (Fingerprint)</th>
                  <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Categories &amp; Product Types</th>
                  {analysisMode && (
                    <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('similarCount')}>Similar{sortArrow('similarCount')}</th>
                  )}
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('itemCount')}>Items{sortArrow('itemCount')}</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={analysisMode ? 5 : 4} className="text-center py-8">
                      <div className="flex items-center justify-center gap-2 text-slate-400">
                        <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        Loading…
                      </div>
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={analysisMode ? 5 : 4} className="text-center py-8 text-slate-400">
                      {total === 0 ? (analysisMode ? 'No overlapping fingerprints found.' : 'No analysis built yet. Click "Build Analysis" to start.') : 'No matches found.'}
                    </td>
                  </tr>
                ) : rows.map(r => (
                  <tr
                    key={r.id}
                    onClick={() => handleSelectCombo(r)}
                    className={`cursor-pointer border-b border-slate-100 transition-colors ${
                      selectedCombo?.id === r.id
                        ? 'bg-blue-50 hover:bg-blue-100'
                        : 'hover:bg-slate-50'
                    }`}
                  >
                    <td className="px-3 py-2 text-right">
                      <span className="inline-flex items-center justify-center min-w-[24px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[10px] font-bold">
                        {r.featureCount}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1 max-w-[500px]">
                        {r.featureCount === 0 && <span className="text-[10px] text-slate-400 italic">No attributes mapped</span>}
                        {r.featureIds.slice(0, 20).map((v, i) => (
                          <span key={i} className="inline-block text-[10px] text-slate-700 bg-white border border-slate-200 px-1 py-0.5 rounded whitespace-nowrap">{v}</span>
                        ))}
                        {r.featureIds.length > 20 && (
                          <span className="inline-block text-[10px] text-slate-500 bg-slate-100 px-1 py-0.5 rounded">
                            +{r.featureIds.length - 20} more
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1 max-w-[200px]">
                        {r.attributeTypes && r.attributeTypes.length > 0 && (
                          <div className="flex flex-wrap gap-0.5">
                            {r.attributeTypes.slice(0, 3).map((at, i) => (
                              <span key={i} className="text-[9px] bg-purple-50 text-purple-600 px-1 py-0.5 rounded">{at}</span>
                            ))}
                            {r.attributeTypes.length > 3 && <span className="text-[9px] text-slate-400">+{r.attributeTypes.length - 3}</span>}
                          </div>
                        )}
                        {r.categories && r.categories.length > 0 && (
                          <div className="flex flex-wrap gap-0.5">
                            {r.categories.slice(0, 3).map((c, i) => (
                              <span key={i} className="text-[9px] bg-indigo-50 text-indigo-600 px-1 py-0.5 rounded">{c}</span>
                            ))}
                            {r.categories.length > 3 && <span className="text-[9px] text-slate-400">+{r.categories.length - 3}</span>}
                          </div>
                        )}
                        {r.productTypes && r.productTypes.length > 0 && (
                          <div className="flex flex-wrap gap-0.5">
                            {r.productTypes.slice(0, 3).map((pt, i) => (
                              <span key={i} className="text-[9px] bg-teal-50 text-teal-600 px-1 py-0.5 rounded">{pt}</span>
                            ))}
                            {r.productTypes.length > 3 && <span className="text-[9px] text-slate-400">+{r.productTypes.length - 3}</span>}
                          </div>
                        )}
                      </div>
                    </td>
                    {analysisMode && (
                      <td className="px-3 py-2 text-right">
                        <span className="inline-flex items-center justify-center min-w-[24px] px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 text-[10px] font-bold">
                          {r.similarCount ?? 0}
                        </span>
                      </td>
                    )}
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
                ))}
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

        {/* Right: Items / Consolidation panel */}
        <div style={{ width: rightPanelWidth, minWidth: MIN_RIGHT_W }} className="flex flex-col overflow-hidden bg-white shrink-0">
          <div className="border-b border-slate-200 bg-slate-50 shrink-0">
            <div className="px-4 pt-2.5 pb-0">
              <h2 className="text-[9px] font-black uppercase tracking-wider text-slate-500 mb-2">
                {selectedCombo
                  ? `Fingerprint (${selectedCombo.featureCount} attrs · ${selectedCombo.itemCount} items)`
                  : 'Select a combination'}
              </h2>
              {selectedCombo && (
                <div className="flex gap-0 border-b-0">
                  <button
                    onClick={() => setRightTab('items')}
                    className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-wider border-b-2 transition-colors ${
                      rightTab === 'items'
                        ? 'border-blue-500 text-blue-600'
                        : 'border-transparent text-slate-400 hover:text-slate-600'
                    }`}
                  >
                    Items ({comboItems.length})
                  </button>
                  {analysisMode && (
                    <button
                      onClick={handleConsolidateClick}
                      className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-wider border-b-2 transition-colors ${
                        rightTab === 'consolidate'
                          ? 'border-violet-500 text-violet-600'
                          : 'border-transparent text-slate-400 hover:text-slate-600'
                      }`}
                    >
                      Consolidate {selectedCombo.similarCount != null ? `(${selectedCombo.similarCount})` : ''}
                    </button>
                  )}
                </div>
              )}
            </div>
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
            ) : rightTab === 'items' ? (
              /* ---- ITEMS TAB ---- */
              isLoadingItems ? (
                <div className="flex items-center justify-center h-32">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : comboItems.length === 0 ? (
                <div className="text-center py-8 text-slate-400 text-xs">No items found</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Item</th>
                      <th className="text-left px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Info</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comboItems.map(item => (
                      <tr key={item.itemId} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="px-3 py-2">
                          <div className="font-semibold text-slate-800">{item.itemId}</div>
                          {item.priority != null && (
                            <div className="text-[9px] text-amber-600 font-bold mt-0.5">P{item.priority}</div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {item.description && <div className="text-slate-600 truncate max-w-[200px]" title={item.description}>{item.description}</div>}
                          <div className="text-[10px] text-slate-400 mt-0.5 flex gap-2">
                            <span>{item.category || 'No Category'}</span>
                            <span>|</span>
                            <span>{item.productType || 'No Type'}</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : (
              /* ---- CONSOLIDATE TAB ---- */
              isLoadingConsolidation ? (
                <div className="flex items-center justify-center h-32">
                  <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : !consolidation ? (
                <div className="flex flex-col items-center justify-center h-32 gap-3">
                  <span className="text-slate-400 text-xs">Load consolidation analysis</span>
                  <button
                    onClick={handleConsolidateClick}
                    className="px-3 py-1.5 rounded-md bg-violet-600 text-white text-[9px] font-black uppercase tracking-wider hover:bg-violet-700"
                  >
                    Load Analysis
                  </button>
                </div>
              ) : (
                <div className="p-4 space-y-4">
                  {/* Summary */}
                  <div className="bg-violet-50 rounded-lg p-3">
                    <div className="flex items-baseline justify-between mb-2">
                      <span className="text-[10px] font-black text-violet-700 uppercase tracking-wider">
                        {consolidation.featureCount} attributes
                      </span>
                      <span className="text-[9px] font-bold text-violet-500">
                        {consolidation.totalSimilar} similar · {consolidation.totalItems.toLocaleString()} total items
                      </span>
                    </div>
                    <div className="text-[9px] text-violet-600 font-semibold mb-1.5">Union of all attributes ({consolidation.unionAttributes.length})</div>
                    <div className="flex flex-wrap gap-1">
                      {consolidation.unionAttributes.map(a => (
                        <span key={a} className="inline-block px-1.5 py-0.5 bg-violet-100 text-violet-700 rounded text-[9px] font-medium">{a}</span>
                      ))}
                    </div>
                    {consolidation.commonAttributes.length > 0 && consolidation.commonAttributes.length < consolidation.unionAttributes.length && (
                      <div className="mt-2">
                        <div className="text-[9px] text-violet-600 font-semibold mb-1">Common to all ({consolidation.commonAttributes.length})</div>
                        <div className="flex flex-wrap gap-1">
                          {consolidation.commonAttributes.map(a => (
                            <span key={a} className="inline-block px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded text-[9px] font-medium">{a}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Merge Options */}
                  <div>
                    <div className="text-[9px] font-black text-slate-500 uppercase tracking-wider mb-2">Merge Options</div>
                    <div className="space-y-2">
                      {consolidation.mergeOptions.map((opt, i) => {
                        const isRecommended = i === 1;
                        const cardColor = opt.totalNoise === 0
                          ? 'border-emerald-200 bg-emerald-50'
                          : opt.listsNeeded === 1
                            ? 'border-rose-200 bg-rose-50'
                            : 'border-amber-200 bg-amber-50';
                        const textColor = opt.totalNoise === 0
                          ? 'text-emerald-700'
                          : opt.listsNeeded === 1
                            ? 'text-rose-700'
                            : 'text-amber-700';
                        return (
                          <div key={opt.label} className={`rounded-lg border p-2.5 ${cardColor} ${isRecommended ? 'ring-2 ring-amber-400' : ''}`}>
                            <div className="flex items-center justify-between mb-1">
                              <span className={`text-[10px] font-black uppercase tracking-wider ${textColor}`}>
                                {opt.label}
                                {isRecommended && <span className="ml-1.5 text-[8px] bg-amber-400 text-white rounded px-1 py-0 font-bold normal-case">recommended</span>}
                              </span>
                              <span className={`text-[10px] font-bold ${textColor}`}>
                                {opt.listsNeeded} fingerprint{opt.listsNeeded !== 1 ? 's' : ''}
                              </span>
                            </div>
                            <div className="flex items-center gap-3 text-[9px]">
                              <span className={textColor}>
                                Extra attrs: <strong>{opt.totalNoise.toLocaleString()}</strong>
                              </span>
                              <span className={textColor}>
                                Max per item: <strong>{opt.maxNoisePerItem}</strong>
                              </span>
                            </div>
                            {opt.canonicalValues.length <= 3 && (
                              <div className="mt-1.5 space-y-1">
                                {opt.canonicalValues.map((listVals, li) => (
                                  <div key={li} className="flex flex-wrap gap-0.5">
                                    <span className="text-[8px] text-slate-400 font-bold mr-1">F{li + 1}:</span>
                                    {listVals.slice(0, 8).map(v => (
                                      <span key={v} className="inline-block px-1 py-0 bg-white/60 rounded text-[8px] font-medium text-slate-600">{v}</span>
                                    ))}
                                    {listVals.length > 8 && <span className="text-[8px] text-slate-400">+{listVals.length - 8}</span>}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Similar Fingerprints */}
                  <div>
                    <div className="text-[9px] font-black text-slate-500 uppercase tracking-wider mb-2">Similar Fingerprints ({consolidation.similarCombos.length})</div>
                    <div className="space-y-2">
                      {consolidation.similarCombos.map(sim => {
                        const relColor = sim.relationship === 'identical'
                          ? 'bg-emerald-100 text-emerald-700'
                          : sim.relationship === 'subset' || sim.relationship === 'superset'
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-slate-100 text-slate-600';
                        return (
                          <div key={sim.comboId} className="rounded-lg border border-slate-200 bg-white p-2.5">
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold text-slate-700">{sim.featureCount} attrs</span>
                                <span className={`inline-block px-1.5 py-0 rounded text-[8px] font-bold uppercase ${relColor}`}>{sim.relationship}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-[9px] font-bold text-slate-500">{sim.overlapPercent}% overlap</span>
                                <span className="text-[9px] text-slate-400">{sim.itemCount.toLocaleString()} items</span>
                              </div>
                            </div>
                            {sim.commonAttributes.length > 0 && (
                              <div className="mb-1.5">
                                <div className="text-[8px] font-black text-slate-400 uppercase mb-0.5">Common</div>
                                <div className="flex flex-wrap gap-0.5">
                                  {sim.commonAttributes.slice(0, 8).map(a => (
                                    <span key={a} className="inline-block px-1 py-0 bg-emerald-50 text-emerald-700 rounded text-[8px]">{a}</span>
                                  ))}
                                  {sim.commonAttributes.length > 8 && <span className="text-[8px] text-slate-400">+{sim.commonAttributes.length - 8}</span>}
                                </div>
                              </div>
                            )}
                            {sim.uniqueAttributes.length > 0 && (
                              <div>
                                <div className="text-[8px] font-black text-slate-400 uppercase mb-0.5">Unique to this set</div>
                                <div className="flex flex-wrap gap-0.5">
                                  {sim.uniqueAttributes.slice(0, 8).map(a => (
                                    <span key={a} className="inline-block px-1 py-0 bg-rose-50 text-rose-600 rounded text-[8px]">{a}</span>
                                  ))}
                                  {sim.uniqueAttributes.length > 8 && <span className="text-[8px] text-slate-400">+{sim.uniqueAttributes.length - 8}</span>}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )
            )}
          </div>

          {/* Footer (items tab only) */}
          {selectedCombo && rightTab === 'items' && comboItems.length > 0 && (
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

export default AttributeCombinations;