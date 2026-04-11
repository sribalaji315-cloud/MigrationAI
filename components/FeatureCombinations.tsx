import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { User, FeatureCombinationJobProgress, FeatureCombinationRow, FeatureCombinationItem, ConsolidationAnalysis, SubsetMergeDetail, VariantComparisonResponse, CrossFeatureResponse } from '../types';
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

  // Right panel tab + consolidation state
  const [rightTab, setRightTab] = useState<'items' | 'consolidate'>('items');
  const [consolidation, setConsolidation] = useState<ConsolidationAnalysis | null>(null);
  const [isLoadingConsolidation, setIsLoadingConsolidation] = useState(false);

  // Analysis mode
  const [analysisMode, setAnalysisMode] = useState(false);
  const [subsetMergeDetail, setSubsetMergeDetail] = useState<SubsetMergeDetail | null>(null);
  const [isLoadingSubsetDetail, setIsLoadingSubsetDetail] = useState(false);
  const [computingStrategy, setComputingStrategy] = useState<string | null>(null);
  const [savedPlanFeatureIds, setSavedPlanFeatureIds] = useState<Set<string>>(new Set());
  const consolidationPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // On-demand variant comparison & cross-feature state
  const [variantData, setVariantData] = useState<VariantComparisonResponse | null>(null);
  const [isLoadingVariants, setIsLoadingVariants] = useState(false);
  const [crossFeatureData, setCrossFeatureData] = useState<CrossFeatureResponse | null>(null);
  const [isLoadingCrossFeatures, setIsLoadingCrossFeatures] = useState(false);

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
  const prevStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevStatusRef.current === 'running' && jobProgress?.status === 'completed') {
      fetchList(0, search, filterFeatureIds, filterAttributeTypes, filterPriorities, filterStatuses, sortBy, sortDir, analysisMode);
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
  const fetchList = useCallback(async (pageNum: number, searchTerm: string, featIds: string[], attrTypes: string[], prios: string[], statuses: string[], sBy?: string, sDir?: string, analysis?: boolean) => {
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

  useEffect(() => { fetchList(page, search, filterFeatureIds, filterAttributeTypes, filterPriorities, filterStatuses, sortBy, sortDir, analysisMode); }, [page, search, filterFeatureIds, filterAttributeTypes, filterPriorities, filterStatuses, sortBy, sortDir, analysisMode, fetchList]);

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
    setConsolidation(null);
    setSubsetMergeDetail(null);
    setComputingStrategy(null);
    setVariantData(null);
    setCrossFeatureData(null);
    if (consolidationPollRef.current) clearTimeout(consolidationPollRef.current);
    if (analysisMode) {
      // In analysis mode, auto-open consolidate tab but do NOT fetch analysis yet
      setRightTab('consolidate');
      if (combo.comboCountForFeature > 1) {
        loadExistingPlan(combo.featureId);
      }
    } else {
      setRightTab('items');
    }
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
  }, [selectedCombo, analysisMode]);

  // --- Fetch consolidation analysis on demand ---
  const handleConsolidateClick = useCallback(() => {
    if (!selectedCombo || selectedCombo.comboCountForFeature <= 1) return;
    setRightTab('consolidate');
    // Skip re-fetch if we already have data for this feature
    if (consolidation && consolidation.featureId === selectedCombo.featureId) return;
    setIsLoadingConsolidation(true);
    setConsolidation(null);
    dbService.fetchConsolidationAnalysis(selectedCombo.featureId)
      .then(data => setConsolidation(data))
      .catch(err => { console.error('consolidation fetch failed', err); setConsolidation(null); })
      .finally(() => setIsLoadingConsolidation(false));
  }, [selectedCombo, consolidation]);

  // --- Toggle analysis mode ---
  const handleToggleAnalysisMode = useCallback(() => {
    setAnalysisMode(prev => {
      const next = !prev;
      setPage(0);
      setSelectedCombo(null);
      setComboItems([]);
      setConsolidation(null);
      setSubsetMergeDetail(null);
      setRightTab(next ? 'consolidate' : 'items');
      return next;
    });
  }, []);

  // --- Suggest Subset Merge (on demand) ---
  const handleTriggerStrategy = useCallback((strategy: string) => {
    if (!selectedCombo) return;
    const featureId = selectedCombo.featureId;
    setComputingStrategy(strategy);
    setSubsetMergeDetail(null);
    setIsLoadingSubsetDetail(true);

    // Clear any existing poll
    if (consolidationPollRef.current) clearTimeout(consolidationPollRef.current);

    dbService.triggerConsolidationCompute(featureId, strategy)
      .then(() => {
        // Start polling for completion
        const poll = () => {
          dbService.fetchConsolidationPlan(featureId)
            .then(plan => {
              if (!plan) {
                consolidationPollRef.current = setTimeout(poll, 1500);
                return;
              }
              if (plan.status === 'computing') {
                consolidationPollRef.current = setTimeout(poll, 1500);
                return;
              }
              // completed or failed
              setSubsetMergeDetail(plan);
              setIsLoadingSubsetDetail(false);
              setComputingStrategy(null);
              if (plan.status === 'completed') {
                setSavedPlanFeatureIds(prev => new Set([...prev, featureId]));
              }
            })
            .catch(() => {
              consolidationPollRef.current = setTimeout(poll, 2000);
            });
        };
        consolidationPollRef.current = setTimeout(poll, 1000);
      })
      .catch(err => {
        console.error('trigger consolidation failed', err);
        setIsLoadingSubsetDetail(false);
        setComputingStrategy(null);
      });
  }, [selectedCombo]);

  // Cleanup poll on unmount or feature change
  useEffect(() => {
    return () => { if (consolidationPollRef.current) clearTimeout(consolidationPollRef.current); };
  }, [selectedCombo?.featureId]);

  // --- Load existing plan when selecting a feature ---
  const loadExistingPlan = useCallback((featureId: string) => {
    dbService.fetchConsolidationPlan(featureId)
      .then(plan => {
        if (plan && plan.status === 'completed') {
          setSubsetMergeDetail(plan);
          setSavedPlanFeatureIds(prev => new Set([...prev, featureId]));
        } else if (plan && plan.status === 'computing') {
          setIsLoadingSubsetDetail(true);
          setComputingStrategy(plan.strategy);
          // Start polling
          const poll = () => {
            dbService.fetchConsolidationPlan(featureId)
              .then(p => {
                if (!p || p.status === 'computing') {
                  consolidationPollRef.current = setTimeout(poll, 1500);
                  return;
                }
                setSubsetMergeDetail(p);
                setIsLoadingSubsetDetail(false);
                setComputingStrategy(null);
                if (p.status === 'completed') {
                  setSavedPlanFeatureIds(prev => new Set([...prev, featureId]));
                }
              })
              .catch(() => { consolidationPollRef.current = setTimeout(poll, 2000); });
          };
          consolidationPollRef.current = setTimeout(poll, 1000);
        }
      })
      .catch(() => { /* no existing plan — that's fine */ });
  }, []);

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
        <span className="text-[9px] text-slate-400 font-medium ml-auto">
          {total.toLocaleString()} {analysisMode ? 'unique features' : 'combinations'}
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
                      <div className="font-semibold text-slate-800">
                        {r.featureId}
                        {analysisMode && (r.savedPlanStrategy || savedPlanFeatureIds.has(r.featureId)) && (
                          <span className="ml-1.5 inline-block px-1 py-0 bg-emerald-100 text-emerald-700 rounded text-[8px] font-bold uppercase">saved</span>
                        )}
                      </div>
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

        {/* Right: Items / Consolidation panel */}
        <div style={{ width: rightPanelWidth, minWidth: MIN_RIGHT_W }} className="flex flex-col overflow-hidden bg-white shrink-0">
          {/* Panel header with tabs */}
          <div className="border-b border-slate-200 bg-slate-50 shrink-0">
            <div className="px-4 pt-2.5 pb-0">
              <h2 className="text-[9px] font-black uppercase tracking-wider text-slate-500 mb-2">
                {selectedCombo
                  ? selectedCombo.featureId + (selectedCombo.description ? ` — ${selectedCombo.description}` : '')
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
                      disabled={selectedCombo.comboCountForFeature <= 1}
                      className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-wider border-b-2 transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                        rightTab === 'consolidate'
                          ? 'border-violet-500 text-violet-600'
                          : 'border-transparent text-slate-400 hover:text-slate-600'
                      }`}
                      title={selectedCombo.comboCountForFeature <= 1 ? 'Only 1 variant — nothing to consolidate' : `Analyze ${selectedCombo.comboCountForFeature} variants`}
                    >
                      Consolidate ({selectedCombo.comboCountForFeature})
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
              )
            ) : (
              /* ---- CONSOLIDATE TAB ---- */
              isLoadingConsolidation ? (
                <div className="flex items-center justify-center h-32">
                  <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : !consolidation ? (
                <div className="text-center py-8 text-slate-400 text-xs">No analysis data</div>
              ) : (
                <div className="p-4 space-y-4">
                  {/* A. Summary */}
                  <div className="bg-violet-50 rounded-lg p-3">
                    <div className="flex items-baseline justify-between mb-2">
                      <span className="text-[10px] font-black text-violet-700 uppercase tracking-wider">
                        {consolidation.featureId}
                      </span>
                      <span className="text-[9px] font-bold text-violet-500">
                        {consolidation.totalVariants} variants · {consolidation.totalItems.toLocaleString()} items
                      </span>
                    </div>
                    <div className="text-[9px] text-violet-600 font-semibold mb-1.5">Union of all values ({consolidation.unionValues.length})</div>
                    <div className="flex flex-wrap gap-1">
                      {consolidation.unionValues.map(v => (
                        <span key={v} className="inline-block px-1.5 py-0.5 bg-violet-100 text-violet-700 rounded text-[9px] font-medium">{v}</span>
                      ))}
                    </div>
                  </div>

                  {/* B. Merge Options — clickable to trigger strategy */}
                  <div>
                    <div className="text-[9px] font-black text-slate-500 uppercase tracking-wider mb-2">Merge Options — click to compute</div>
                    <div className="space-y-2">
                      {consolidation.mergeOptions.map((opt, i) => {
                        const strategyKey = opt.label === 'Full Union' ? 'full_union' : opt.label === 'Subset Merge' ? 'subset_merge' : 'no_merge';
                        const isRecommended = i === 0 ? false : i === consolidation.mergeOptions.length - 1 ? false : true;
                        const isComputing = computingStrategy === strategyKey;
                        const isApplied = subsetMergeDetail?.status === 'completed' && subsetMergeDetail?.strategy === strategyKey;
                        const cardColor = isApplied
                          ? 'border-emerald-300 bg-emerald-50 ring-2 ring-emerald-400'
                          : isComputing
                            ? 'border-violet-300 bg-violet-50 ring-2 ring-violet-400'
                            : opt.totalNoise === 0
                              ? 'border-emerald-200 bg-emerald-50'
                              : opt.listsNeeded === 1
                                ? 'border-rose-200 bg-rose-50'
                                : 'border-amber-200 bg-amber-50';
                        const textColor = isApplied
                          ? 'text-emerald-700'
                          : opt.totalNoise === 0
                            ? 'text-emerald-700'
                            : opt.listsNeeded === 1
                              ? 'text-rose-700'
                              : 'text-amber-700';
                        return (
                          <div
                            key={opt.label}
                            onClick={() => !isComputing && !isLoadingSubsetDetail && handleTriggerStrategy(strategyKey)}
                            className={`rounded-lg border p-2.5 cursor-pointer hover:shadow-md transition-all ${cardColor} ${isRecommended && !isApplied && !isComputing ? 'ring-2 ring-amber-400' : ''}`}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className={`text-[10px] font-black uppercase tracking-wider ${textColor}`}>
                                {opt.label}
                                {isApplied && <span className="ml-1.5 text-[8px] bg-emerald-500 text-white rounded px-1 py-0 font-bold normal-case">applied</span>}
                                {isRecommended && !isApplied && <span className="ml-1.5 text-[8px] bg-amber-400 text-white rounded px-1 py-0 font-bold normal-case">recommended</span>}
                              </span>
                              <div className="flex items-center gap-1.5">
                                {isComputing && (
                                  <div className="w-3 h-3 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                                )}
                                <span className={`text-[10px] font-bold ${textColor}`}>
                                  {opt.listsNeeded} list{opt.listsNeeded !== 1 ? 's' : ''}
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center gap-3 text-[9px]">
                              <span className={textColor}>
                                Noise: <strong>{opt.totalNoise.toLocaleString()}</strong> extra exposures
                              </span>
                              <span className={textColor}>
                                Max per item: <strong>{opt.maxNoisePerItem}</strong>
                              </span>
                            </div>
                            {opt.canonicalValues.length <= 3 && (
                              <div className="mt-1.5 space-y-1">
                                {opt.canonicalValues.map((listVals, li) => (
                                  <div key={li} className="flex flex-wrap gap-0.5">
                                    <span className="text-[8px] text-slate-400 font-bold mr-1">L{li + 1}:</span>
                                    {listVals.map(v => (
                                      <span key={v} className="inline-block px-1 py-0 bg-white/60 rounded text-[8px] font-medium text-slate-600">{v}</span>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* B2. Consolidation Plan Detail */}
                  <div>
                    {isLoadingSubsetDetail && !subsetMergeDetail && (
                      <div className="flex items-center justify-center py-4">
                        <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                        <span className="ml-2 text-[9px] text-violet-500 font-bold uppercase tracking-wider">Computing {computingStrategy?.replace('_', ' ')}…</span>
                      </div>
                    )}
                    {subsetMergeDetail && subsetMergeDetail.status === 'failed' && (
                      <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-center">
                        <span className="text-[9px] font-bold text-rose-600 uppercase">Computation failed</span>
                        {subsetMergeDetail.errorMessage && (
                          <div className="text-[9px] text-rose-500 mt-1">{subsetMergeDetail.errorMessage}</div>
                        )}
                      </div>
                    )}
                    {subsetMergeDetail && subsetMergeDetail.status === 'completed' && (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="text-[9px] font-black text-violet-600 uppercase tracking-wider">
                            {subsetMergeDetail.strategy.replace('_', ' ')}: {subsetMergeDetail.listsNeeded} value list{subsetMergeDetail.listsNeeded !== 1 ? 's' : ''}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="flex items-center gap-1 px-2 py-1 bg-emerald-100 text-emerald-700 rounded text-[9px] font-bold uppercase">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                              Saved
                              {subsetMergeDetail.appliedBy && (
                                <span className="font-normal normal-case text-emerald-500 ml-1">by {subsetMergeDetail.appliedBy}</span>
                              )}
                            </span>
                          </div>
                        </div>
                        {subsetMergeDetail.lists.map(list => (
                          <div key={list.index} className="rounded-lg border border-violet-200 bg-violet-50/50 p-2.5">
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-[10px] font-black text-violet-700 uppercase tracking-wider">
                                Value List {list.index + 1}
                              </span>
                              <span className="text-[9px] font-bold text-violet-500">
                                {list.itemCount.toLocaleString()} item{list.itemCount !== 1 ? 's' : ''}
                                {list.variants && list.variants.length > 0 && (
                                  <span className="ml-1 text-slate-400">· {list.variants.length} variant{list.variants.length !== 1 ? 's' : ''}</span>
                                )}
                              </span>
                            </div>
                            {/* Merged values */}
                            <div className="flex flex-wrap gap-1 mb-2">
                              {list.values.map(v => (
                                <span key={v} className="inline-block px-1.5 py-0.5 bg-violet-100 text-violet-700 rounded text-[9px] font-medium">{v}</span>
                              ))}
                            </div>
                            {/* Variant breakdown */}
                            {list.variants && list.variants.length > 0 && (
                              <div className="mb-2 space-y-1">
                                <div className="text-[8px] font-black text-slate-400 uppercase tracking-wider">Source Variants</div>
                                {list.variants.map((vr, vi) => (
                                  <div key={vi} className="flex items-center gap-1.5 text-[9px]">
                                    <span className="inline-block px-1 py-0 bg-slate-200 text-slate-500 rounded text-[8px] font-bold">V{vi + 1}</span>
                                    <span className="text-slate-500">{vr.values.length} val{vr.values.length !== 1 ? 's' : ''}</span>
                                    <span className="text-slate-400">·</span>
                                    <span className="text-slate-500">{vr.itemCount} item{vr.itemCount !== 1 ? 's' : ''}</span>
                                    <div className="flex flex-wrap gap-0.5 ml-1">
                                      {vr.values.slice(0, 8).map(val => (
                                        <span key={val} className="inline-block px-1 py-0 bg-white border border-slate-200 rounded text-[8px] text-slate-500">{val}</span>
                                      ))}
                                      {vr.values.length > 8 && <span className="text-[8px] text-slate-400">+{vr.values.length - 8}</span>}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                            {/* Items table */}
                            {list.items.length > 0 && (
                              <div className="bg-white rounded border border-violet-100 overflow-hidden">
                                <table className="w-full text-[10px]">
                                  <thead>
                                    <tr className="bg-violet-50/80">
                                      <th className="text-left px-2 py-1 text-[8px] font-black uppercase text-violet-500">Item</th>
                                      <th className="text-left px-2 py-1 text-[8px] font-black uppercase text-violet-500">Description</th>
                                      <th className="text-center px-2 py-1 text-[8px] font-black uppercase text-violet-500">Pri</th>
                                      <th className="text-left px-2 py-1 text-[8px] font-black uppercase text-violet-500">Product</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {list.items.slice(0, 20).map(it => (
                                      <tr key={it.itemId} className="border-t border-violet-50">
                                        <td className="px-2 py-0.5 font-semibold text-slate-700">{it.itemId}</td>
                                        <td className="px-2 py-0.5 text-slate-500 truncate max-w-[120px]">{it.description}</td>
                                        <td className="px-2 py-0.5 text-center">
                                          {it.priority != null ? (
                                            <span className="inline-block px-1 py-0 bg-amber-50 text-amber-600 rounded text-[9px] font-bold">P{it.priority}</span>
                                          ) : <span className="text-slate-300">—</span>}
                                        </td>
                                        <td className="px-2 py-0.5 text-slate-400">{it.productType || '—'}</td>
                                      </tr>
                                    ))}
                                    {list.items.length > 20 && (
                                      <tr>
                                        <td colSpan={4} className="px-2 py-1 text-center text-[8px] text-violet-400 font-bold">
                                          +{list.items.length - 20} more items (showing first 20)
                                        </td>
                                      </tr>
                                    )}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* C. Variant Comparison (on-demand) */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[9px] font-black text-slate-500 uppercase tracking-wider">Variant Comparison</div>
                      {!variantData && !isLoadingVariants && (
                        <button
                          onClick={() => {
                            setIsLoadingVariants(true);
                            dbService.fetchVariantComparison(consolidation.featureId)
                              .then(data => setVariantData(data))
                              .catch(err => { console.error('variant fetch failed', err); setVariantData(null); })
                              .finally(() => setIsLoadingVariants(false));
                          }}
                          className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-600 text-[9px] font-bold hover:bg-indigo-100 transition-colors"
                        >
                          Load Variants
                        </button>
                      )}
                    </div>
                    {isLoadingVariants && (
                      <div className="flex items-center justify-center py-6">
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-indigo-500" />
                        <span className="ml-2 text-[10px] text-slate-400">Loading variant comparison…</span>
                      </div>
                    )}
                    {variantData && variantData.variants.length > 0 && (
                      <div className="space-y-2">
                        {variantData.variants.map(v => {
                          const variantSet = new Set(v.values);
                          const valueCounts: Record<string, number> = {};
                          variantData.unionValues.forEach(uv => {
                            valueCounts[uv] = variantData.variants.filter(ov => ov.values.includes(uv)).length;
                          });

                          return (
                            <div key={v.comboId} className={`rounded-lg border p-2.5 ${
                              selectedCombo?.id === v.comboId
                                ? 'border-blue-300 bg-blue-50'
                                : 'border-slate-200 bg-white'
                            }`}>
                              <div className="flex items-center justify-between mb-1.5">
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] font-bold text-slate-700">{v.values.length} val{v.values.length !== 1 ? 's' : ''}</span>
                                  <span className="text-[9px] text-slate-400">{v.itemCount.toLocaleString()} items</span>
                                </div>
                                <div className="flex gap-0.5">
                                  {v.priorities.slice(0, 3).map((p, pi) => (
                                    <span key={pi} className="inline-block px-1 py-0 bg-amber-50 text-amber-600 rounded text-[8px] font-bold">P{p}</span>
                                  ))}
                                </div>
                              </div>
                              {v.productTypes.length > 0 && (
                                <div className="flex flex-wrap gap-1 mb-1.5">
                                  {v.productTypes.slice(0, 4).map(pt => (
                                    <span key={pt} className="inline-block px-1 py-0 bg-slate-100 text-slate-500 rounded text-[8px] font-medium">{pt}</span>
                                  ))}
                                  {v.productTypes.length > 4 && <span className="text-[8px] text-slate-400">+{v.productTypes.length - 4}</span>}
                                </div>
                              )}
                              <div className="flex flex-wrap gap-0.5">
                                {variantData.unionValues.map(uv => {
                                  const inVariant = variantSet.has(uv);
                                  const inAllVariants = valueCounts[uv] === variantData.variants.length;
                                  const inSomeVariants = valueCounts[uv] > 1;
                                  if (!inVariant) {
                                    return (
                                      <span key={uv} className="inline-block px-1 py-0 rounded text-[8px] font-medium bg-slate-100 text-slate-300 line-through">{uv}</span>
                                    );
                                  }
                                  const color = inAllVariants
                                    ? 'bg-emerald-100 text-emerald-700'
                                    : inSomeVariants
                                      ? 'bg-amber-100 text-amber-700'
                                      : 'bg-rose-100 text-rose-700';
                                  return (
                                    <span key={uv} className={`inline-block px-1 py-0 rounded text-[8px] font-medium ${color}`}>{uv}</span>
                                  );
                                })}
                              </div>
                              {v.isSubsetOf.length > 0 && (
                                <div className="mt-1 text-[8px] text-slate-400">
                                  ⊂ subset of {v.isSubsetOf.length} larger variant{v.isSubsetOf.length !== 1 ? 's' : ''}
                                </div>
                              )}
                              {v.noiseIfUnion > 0 && (
                                <div className="mt-0.5 text-[8px] text-rose-400">
                                  +{v.noiseIfUnion} extra value{v.noiseIfUnion !== 1 ? 's' : ''} if fully merged ({v.noiseItems.toLocaleString()} noise)
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* D. Cross-feature matches (on-demand) */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[9px] font-black text-slate-500 uppercase tracking-wider">Cross-Feature Matches</div>
                      {!crossFeatureData && !isLoadingCrossFeatures && (
                        <button
                          onClick={() => {
                            setIsLoadingCrossFeatures(true);
                            dbService.fetchCrossFeatureMatches(consolidation.featureId)
                              .then(data => setCrossFeatureData(data))
                              .catch(err => { console.error('cross-feature fetch failed', err); setCrossFeatureData(null); })
                              .finally(() => setIsLoadingCrossFeatures(false));
                          }}
                          className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-600 text-[9px] font-bold hover:bg-indigo-100 transition-colors"
                        >
                          Load Matches
                        </button>
                      )}
                    </div>
                    {isLoadingCrossFeatures && (
                      <div className="flex items-center justify-center py-4">
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-indigo-500" />
                        <span className="ml-2 text-[10px] text-slate-400">Loading cross-feature matches…</span>
                      </div>
                    )}
                    {crossFeatureData && crossFeatureData.crossFeatureMatches.length > 0 && (
                      <div className="space-y-1">
                        {crossFeatureData.crossFeatureMatches.map(cf => {
                          const relColor = cf.relationship === 'identical'
                            ? 'bg-emerald-100 text-emerald-700'
                            : cf.relationship === 'subset' || cf.relationship === 'superset'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-slate-100 text-slate-600';
                          return (
                            <div key={cf.featureId} className="flex items-center justify-between border border-slate-100 rounded-lg px-2.5 py-1.5 hover:bg-slate-50">
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold text-slate-700">{cf.featureId}</span>
                                <span className={`inline-block px-1.5 py-0 rounded text-[8px] font-bold uppercase ${relColor}`}>
                                  {cf.relationship}
                                </span>
                              </div>
                              <span className="text-[9px] font-bold text-slate-500">{cf.overlapPercent}% overlap</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {crossFeatureData && crossFeatureData.crossFeatureMatches.length === 0 && (
                      <div className="text-[9px] text-slate-400 italic">No cross-feature matches found (≥50% overlap).</div>
                    )}
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

export default FeatureCombinations;
