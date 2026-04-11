import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MergedWorkspaceMappingRow,
  MigrationManifestAttributeGroup,
  MigrationManifestFilters,
  MigrationManifestItemSummary,
  MigrationManifestRow,
  MigrationManifestValueDetail,
  User,
} from '../types';
import { dbService } from '../services/dbService';

interface MigrationManifestProps {
  currentUser: User;
  onClose: () => void;
}

const PAGE_SIZE = 20;
const MIN_LEFT_W = 360;
const MIN_RIGHT_W = 340;

const sourceTone: Record<string, string> = {
  original: 'bg-slate-100 text-slate-700 border-slate-200',
  value_merge: 'bg-amber-100 text-amber-800 border-amber-200',
  attr_merge: 'bg-sky-100 text-sky-800 border-sky-200',
};

const joinValues = (values: string[]) => values.length > 0 ? values.join(', ') : '—';

const dedupeValues = (rows: MigrationManifestRow[], selector: (row: MigrationManifestRow) => string[]) => {
  const seen = new Set<string>();
  const values: string[] = [];
  rows.forEach((row) => {
    selector(row).forEach((value) => {
      const normalized = String(value || '').trim();
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        values.push(normalized);
      }
    });
  });
  return values;
};

const MigrationManifest: React.FC<MigrationManifestProps> = ({ currentUser, onClose }) => {
  void currentUser;

  const [isReady, setIsReady] = useState<boolean | null>(null);
  const [readyInfo, setReadyInfo] = useState<{ attributeCombinations: number; featureCombinations: number }>({ attributeCombinations: 0, featureCombinations: 0 });

  const [filters, setFilters] = useState<MigrationManifestFilters>({
    categories: [],
    productTypes: [],
    priorities: [],
    sources: [],
    noiseTypes: [],
    attributeTypes: [],
    targetAttributes: [],
  });
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [productType, setProductType] = useState('');
  const [priority, setPriority] = useState('');
  const [source, setSource] = useState('');
  const [hasNoise, setHasNoise] = useState('');
  const [hasMapping, setHasMapping] = useState('');
  const [sortBy, setSortBy] = useState('itemPriority');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);

  const [items, setItems] = useState<MigrationManifestItemSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoadingItems, setIsLoadingItems] = useState(false);

  const [selectedItem, setSelectedItem] = useState<MigrationManifestItemSummary | null>(null);
  const [attributeGroups, setAttributeGroups] = useState<MigrationManifestAttributeGroup[]>([]);
  const [isLoadingAttributes, setIsLoadingAttributes] = useState(false);
  const [selectedAttribute, setSelectedAttribute] = useState<MigrationManifestAttributeGroup | null>(null);
  const [valueDetail, setValueDetail] = useState<MigrationManifestValueDetail | null>(null);
  const [isLoadingValues, setIsLoadingValues] = useState(false);
  const [isSavingValue, setIsSavingValue] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [showMergedView, setShowMergedView] = useState(false);
  const [mergedMappings, setMergedMappings] = useState<MergedWorkspaceMappingRow[]>([]);
  const [isLoadingMerged, setIsLoadingMerged] = useState(false);
  const [mergedSummary, setMergedSummary] = useState<{ totalRows: number; distinctItems: number }>({ totalRows: 0, distinctItems: 0 });

  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [rightPanelWidth, setRightPanelWidth] = useState(420);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resetSelection = useCallback(() => {
    setSelectedItem(null);
    setAttributeGroups([]);
    setSelectedAttribute(null);
    setValueDetail(null);
  }, []);

  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    draggingRef.current = true;
    const startX = event.clientX;
    const startWidth = rightPanelWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const containerWidth = containerRef.current.getBoundingClientRect().width;
      const delta = startX - moveEvent.clientX;
      const newWidth = Math.max(MIN_RIGHT_W, Math.min(containerWidth - MIN_LEFT_W, startWidth + delta));
      setRightPanelWidth(newWidth);
    };

    const onMouseUp = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [rightPanelWidth]);

  const loadFilters = useCallback(async () => {
    try {
      const nextFilters = await dbService.fetchMigrationManifestFilters();
      setFilters(nextFilters);
    } catch {
      // Ignore filter refresh errors.
    }
  }, []);

  const loadItemSummaries = useCallback(async (nextPage = page, nextSearch = search) => {
    setIsLoadingItems(true);
    try {
      const response = await dbService.fetchMigrationManifestItemSummaries({
        search: nextSearch || undefined,
        category: category || undefined,
        productType: productType || undefined,
        priority: priority ? Number(priority) : undefined,
        source: source || undefined,
        hasNoise: hasNoise === '' ? undefined : hasNoise === 'true',
        hasMapping: hasMapping === '' ? undefined : hasMapping === 'true',
        sortBy,
        sortDir,
        limit: PAGE_SIZE,
        offset: nextPage * PAGE_SIZE,
      });
      setItems(response.items);
      setTotal(response.total);
      if (response.items.length === 0) {
        resetSelection();
      } else {
        setSelectedItem((current) => {
          const existing = current ? response.items.find((item) => item.itemId === current.itemId) : null;
          return existing || response.items[0];
        });
      }
    } finally {
      setIsLoadingItems(false);
    }
  }, [page, search, category, productType, priority, source, hasNoise, hasMapping, sortBy, sortDir, resetSelection]);

  const loadAttributes = useCallback(async (itemId: string) => {
    setIsLoadingAttributes(true);
    try {
      const response = await dbService.fetchMigrationManifestItemAttributes(itemId);
      setAttributeGroups(response.attributes);
      if (response.attributes.length === 0) {
        setSelectedAttribute(null);
        setValueDetail(null);
      } else {
        setSelectedAttribute((current) => {
          const existing = current
            ? response.attributes.find((attribute) => attribute.targetAttributeId === current.targetAttributeId)
            : null;
          return existing || response.attributes[0];
        });
      }
    } finally {
      setIsLoadingAttributes(false);
    }
  }, []);

  const loadValueDetail = useCallback(async (itemId: string, targetAttributeId: string) => {
    if (!targetAttributeId) {
      setValueDetail(null);
      return;
    }
    setIsLoadingValues(true);
    try {
      const response = await dbService.fetchMigrationManifestValueDetail(itemId, targetAttributeId);
      setValueDetail(response);
    } finally {
      setIsLoadingValues(false);
    }
  }, []);

  const loadMergedMappings = useCallback(async (itemId: string) => {
    setIsLoadingMerged(true);
    try {
      const response = await dbService.fetchMergedWorkspaceMappings(itemId);
      setMergedMappings(response.items);
    } catch {
      setMergedMappings([]);
    } finally {
      setIsLoadingMerged(false);
    }
  }, []);

  const loadMergedSummary = useCallback(async () => {
    try {
      const summary = await dbService.fetchMergedWorkspaceMappingsSummary();
      setMergedSummary(summary);
    } catch {
      // Ignore summary refresh errors.
    }
  }, []);

  useEffect(() => {
    loadFilters();
    loadMergedSummary();
    dbService.checkMigrationManifestReady().then((res) => {
      setIsReady(res.ready);
      setReadyInfo({ attributeCombinations: res.attributeCombinations, featureCombinations: res.featureCombinations });
    }).catch(() => setIsReady(false));
  }, [loadFilters, loadMergedSummary]);

  useEffect(() => {
    loadItemSummaries(page, search);
  }, [page, search, category, productType, priority, source, hasNoise, hasMapping, sortBy, sortDir, loadItemSummaries]);

  useEffect(() => {
    if (selectedItem?.itemId) {
      loadAttributes(selectedItem.itemId);
    }
  }, [selectedItem?.itemId, loadAttributes]);

  useEffect(() => {
    if (selectedItem?.itemId && showMergedView) {
      loadMergedMappings(selectedItem.itemId);
    } else {
      setMergedMappings([]);
    }
  }, [selectedItem?.itemId, showMergedView, loadMergedMappings]);

  useEffect(() => {
    if (selectedItem?.itemId && selectedAttribute?.targetAttributeId) {
      loadValueDetail(selectedItem.itemId, selectedAttribute.targetAttributeId);
    } else {
      setValueDetail(null);
    }
  }, [selectedItem?.itemId, selectedAttribute?.targetAttributeId, loadValueDetail]);

  const refreshCurrentSelection = useCallback(async () => {
    await loadItemSummaries(page, search);
    if (selectedItem?.itemId) {
      await loadAttributes(selectedItem.itemId);
      if (selectedAttribute?.targetAttributeId) {
        await loadValueDetail(selectedItem.itemId, selectedAttribute.targetAttributeId);
      }
    }
  }, [loadAttributes, loadItemSummaries, loadValueDetail, page, search, selectedAttribute?.targetAttributeId, selectedItem?.itemId]);

  const handleSaveValueMerge = useCallback(async () => {
    if (!selectedItem?.itemId || !selectedAttribute?.targetAttributeId) return;
    setIsSavingValue(true);
    setStatusMessage(null);
    try {
      const result = await dbService.saveManifestToWorkspace(selectedItem.itemId, selectedAttribute.targetAttributeId, ['value_merge']);
      await refreshCurrentSelection();
      await loadMergedSummary();
      setStatusMessage({ type: 'success', text: `Saved ${result.mergedMappingsCreated + result.mergedMappingsUpdated} merged mapping(s) to workspace.` });
    } catch (error: any) {
      setStatusMessage({ type: 'error', text: error?.message || 'Failed to save value merge selection.' });
    } finally {
      setIsSavingValue(false);
    }
  }, [refreshCurrentSelection, loadMergedSummary, selectedAttribute?.targetAttributeId, selectedItem?.itemId]);

  const handleSearch = useCallback(() => {
    setPage(0);
    setSearch(searchInput.trim());
    resetSelection();
  }, [searchInput, resetSelection]);

  const handleFilterChange = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPage(0);
    resetSelection();
  };

  const handleSort = (column: string) => {
    if (sortBy === column) {
      setSortDir((current) => current === 'desc' ? 'asc' : 'desc');
    } else {
      setSortBy(column);
      setSortDir('desc');
    }
    setPage(0);
  };

  const sortArrow = (column: string) => sortBy === column ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  const selectedOriginalValues = useMemo(() => (
    selectedAttribute ? dedupeValues(selectedAttribute.features, (row) => row.originalValues) : []
  ), [selectedAttribute]);
  const selectedTargetValues = useMemo(() => (
    selectedAttribute ? dedupeValues(selectedAttribute.features, (row) => row.targetValues) : []
  ), [selectedAttribute]);
  const selectedNoiseValues = useMemo(() => (
    selectedAttribute ? dedupeValues(selectedAttribute.features, (row) => row.noiseValues) : []
  ), [selectedAttribute]);
  const isValueMergeSaved = useMemo(() => (
    valueDetail ? valueDetail.entries.some((row) => row.source === 'value_merge' && row.isAccepted) : false
  ), [valueDetail]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-50 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-black text-slate-800 uppercase tracking-wider">Migration Manifest</h1>
          {isReady === false ? (
            <span className="text-[9px] font-black uppercase tracking-wider text-amber-600">
              Prerequisites missing
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {mergedSummary.totalRows > 0 ? (
            <span className="text-[9px] font-bold text-slate-500">
              {mergedSummary.totalRows} merged mapping{mergedSummary.totalRows !== 1 ? 's' : ''} · {mergedSummary.distinctItems} item{mergedSummary.distinctItems !== 1 ? 's' : ''}
            </span>
          ) : null}
          <button
            onClick={() => setShowMergedView((prev) => !prev)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[9px] font-black uppercase tracking-wider transition-all ${showMergedView ? 'bg-violet-600 text-white hover:bg-violet-700' : 'bg-violet-100 text-violet-700 hover:bg-violet-200'}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            {showMergedView ? 'Showing Merged' : 'Show Merged'}
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

      {statusMessage ? (
        <div className={`px-5 py-2 text-[11px] border-b shrink-0 ${statusMessage.type === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-rose-50 text-rose-700 border-rose-100'}`}>
          {statusMessage.text}
        </div>
      ) : null}

      {isReady === false ? (
        <div className="px-5 py-3 text-[11px] border-b shrink-0 bg-amber-50 text-amber-800 border-amber-100">
          Attribute Combinations ({readyInfo.attributeCombinations}) and Feature Combinations ({readyInfo.featureCombinations}) must be built before viewing the manifest.
          {readyInfo.attributeCombinations === 0 ? ' Run Attribute Combinations analysis first.' : ''}
          {readyInfo.featureCombinations === 0 ? ' Run Feature Combinations analysis first.' : ''}
        </div>
      ) : null}

      <div className="px-5 py-2 bg-white border-b border-slate-100 flex items-center gap-2 shrink-0 flex-wrap">
        <input
          type="text"
          placeholder="Search by item ID or description..."
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleSearch();
          }}
          className="flex-1 min-w-[180px] px-3 py-1.5 border border-slate-200 rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <button
          onClick={handleSearch}
          className="px-3 py-1.5 bg-slate-100 text-slate-600 rounded-md text-[9px] font-black uppercase tracking-wider hover:bg-slate-200 transition-all"
        >
          Search
        </button>
        <div className="h-4 w-px bg-slate-200" />
        <select value={category} onChange={(event) => handleFilterChange(setCategory)(event.target.value)} className="px-3 py-1.5 border border-slate-200 rounded-md text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
          <option value="">All Categories</option>
          {filters.categories.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <select value={productType} onChange={(event) => handleFilterChange(setProductType)(event.target.value)} className="px-3 py-1.5 border border-slate-200 rounded-md text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
          <option value="">All Products</option>
          {filters.productTypes.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <select value={priority} onChange={(event) => handleFilterChange(setPriority)(event.target.value)} className="px-3 py-1.5 border border-slate-200 rounded-md text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
          <option value="">All Priorities</option>
          {filters.priorities.map((option) => <option key={option} value={String(option)}>{option}</option>)}
        </select>
        <select value={source} onChange={(event) => handleFilterChange(setSource)(event.target.value)} className="px-3 py-1.5 border border-slate-200 rounded-md text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
          <option value="">All Sources</option>
          {filters.sources.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <select value={hasNoise} onChange={(event) => handleFilterChange(setHasNoise)(event.target.value)} className="px-3 py-1.5 border border-slate-200 rounded-md text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
          <option value="">Noise or Clean</option>
          <option value="true">Noise only</option>
          <option value="false">Clean only</option>
        </select>
        <select value={hasMapping} onChange={(event) => handleFilterChange(setHasMapping)(event.target.value)} className="px-3 py-1.5 border border-slate-200 rounded-md text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
          <option value="">Mapped or Unmapped</option>
          <option value="true">Mapped only</option>
          <option value="false">Unmapped only</option>
        </select>
        <button
          onClick={() => {
            setSearchInput('');
            setSearch('');
            setCategory('');
            setProductType('');
            setPriority('');
            setSource('');
            setHasNoise('');
            setHasMapping('');
            setSortBy('itemPriority');
            setSortDir('desc');
            setPage(0);
            resetSelection();
          }}
          className="px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-blue-600 hover:text-blue-800"
        >
          Reset
        </button>
        <span className="text-[9px] text-slate-400 font-medium ml-auto">{total.toLocaleString()} items · {PAGE_SIZE} per page</span>
      </div>

      <div ref={containerRef} className="flex flex-1 overflow-hidden">
        <div className="flex flex-col overflow-hidden" style={{ width: `calc(100% - ${rightPanelWidth}px)`, minWidth: MIN_LEFT_W }}>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr>
                  <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Item</th>
                  <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Category / Product</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('itemPriority')}>Priority{sortArrow('itemPriority')}</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('totalRows')}>Rows{sortArrow('totalRows')}</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('comboItemCount')}>Combo Items{sortArrow('comboItemCount')}</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('valueMergeCount')}>Value Merge{sortArrow('valueMergeCount')}</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Mapped</th>
                </tr>
              </thead>
              <tbody>
                {isLoadingItems ? (
                  <tr>
                    <td colSpan={7} className="text-center py-8">
                      <div className="flex items-center justify-center gap-2 text-slate-400">
                        <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        Loading items...
                      </div>
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-8 text-slate-400">
                      {total === 0 ? 'No manifest built yet. Click "Build Manifest" to start.' : 'No matching items found.'}
                    </td>
                  </tr>
                ) : items.map((item) => (
                  <tr
                    key={item.itemId}
                    onClick={() => setSelectedItem(item)}
                    className={`cursor-pointer border-b border-slate-100 transition-colors ${selectedItem?.itemId === item.itemId ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-slate-50'}`}
                  >
                    <td className="px-3 py-2">
                      <div className="font-semibold text-slate-800">{item.itemId}</div>
                      <div className="text-[10px] text-slate-400 truncate max-w-[240px]">{item.itemDescription || 'No description'}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-slate-700">{item.itemCategory || '—'}</div>
                      <div className="text-[10px] text-slate-400">{item.itemProductType || '—'}</div>
                    </td>
                    <td className="px-3 py-2 text-right"><span className="inline-flex items-center justify-center min-w-[26px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-bold">{item.itemPriority ?? '—'}</span></td>
                    <td className="px-3 py-2 text-right"><span className="inline-flex items-center justify-center min-w-[30px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[10px] font-bold">{item.totalRows}</span></td>
                    <td className="px-3 py-2 text-right"><span className="inline-flex items-center justify-center min-w-[30px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 text-[10px] font-bold">{item.comboItemCount}</span></td>
                    <td className="px-3 py-2 text-right"><span className="inline-flex items-center justify-center min-w-[30px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-bold">{item.valueMergeCount}</span></td>
                    <td className="px-3 py-2 text-right"><span className="inline-flex items-center justify-center min-w-[30px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[10px] font-bold">{item.mappedCount}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 ? (
            <div className="flex items-center justify-between px-3 py-2 bg-white border-t border-slate-200 shrink-0">
              <button
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                disabled={page === 0}
                className="px-2 py-1 text-[9px] font-bold text-slate-500 bg-slate-100 rounded hover:bg-slate-200 disabled:opacity-40"
              >
                ← Prev 20
              </button>
              <span className="text-[9px] text-slate-400 font-medium">Page {page + 1} of {totalPages}</span>
              <button
                onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
                disabled={page >= totalPages - 1}
                className="px-2 py-1 text-[9px] font-bold text-slate-500 bg-slate-100 rounded hover:bg-slate-200 disabled:opacity-40"
              >
                Next 20 →
              </button>
            </div>
          ) : null}
        </div>

        <div onMouseDown={handleMouseDown} className="w-1.5 cursor-col-resize bg-slate-200 hover:bg-blue-400 active:bg-blue-500 transition-colors shrink-0" />

        <div style={{ width: rightPanelWidth, minWidth: MIN_RIGHT_W }} className="flex flex-col overflow-hidden bg-white shrink-0">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 shrink-0">
            <div className="text-[9px] font-black uppercase tracking-wider text-slate-500">Selected Item</div>
            {selectedItem ? (
              <>
                <div className="mt-1 text-sm font-black text-slate-800">{selectedItem.itemId}</div>
                <div className="text-[10px] text-slate-400">{selectedItem.itemDescription || 'No description'}</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[10px] font-bold">{selectedItem.itemCategory || 'No category'}</span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[10px] font-bold">{selectedItem.itemProductType || 'No product type'}</span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-bold">P{selectedItem.itemPriority ?? '—'}</span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 text-[10px] font-bold">{selectedItem.comboItemCount} item{selectedItem.comboItemCount !== 1 ? 's' : ''} in combo</span>
                </div>
              </>
            ) : (
              <div className="mt-1 text-[11px] text-slate-400">Select an item to inspect merge suggestions.</div>
            )}
          </div>

          <div className="flex-1 overflow-auto">
            <div className="px-4 py-3 border-b border-slate-100">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[9px] font-black uppercase tracking-wider text-slate-500">Attribute Merge Suggestions</div>
                  <div className="text-[11px] text-slate-400">Select an attribute, then review value merge suggestions.</div>
                </div>
                <div className="text-[10px] text-slate-400">{attributeGroups.length} attributes</div>
              </div>
            </div>

            <div className="px-3 py-3 space-y-2 border-b border-slate-100">
              {isLoadingAttributes ? (
                <div className="px-2 py-6 text-sm text-slate-400">Loading attributes...</div>
              ) : attributeGroups.length === 0 ? (
                <div className="px-2 py-6 text-sm text-slate-400">No attribute suggestions available.</div>
              ) : attributeGroups.map((group) => (
                <button
                  key={group.targetAttributeId || `attr-${group.features[0]?.legacyFeatureId || 'unknown'}`}
                  type="button"
                  onClick={() => setSelectedAttribute(group)}
                  className={`w-full text-left rounded-lg border p-3 transition-all ${selectedAttribute?.targetAttributeId === group.targetAttributeId ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-slate-800 break-words">{group.targetAttributeId || '(unmapped attribute)'}</div>
                      <div className="text-[10px] text-slate-400">{group.attributeType || 'No type'} · {group.features.length} feature rows</div>
                    </div>
                    <div className="flex gap-1">
                      {group.hasValueMerge ? <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 text-[9px] font-bold uppercase">Value Merge</span> : null}
                    </div>
                  </div>
                  <div className="mt-2 text-[10px] text-slate-500 break-words">Features: {group.features.map((row) => row.legacyFeatureId).join(', ') || '—'}</div>
                </button>
              ))}
            </div>

            <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/70">
              <div className="text-[9px] font-black uppercase tracking-wider text-slate-500">Selected Attribute</div>
              {selectedAttribute ? (
                <div className="mt-2 grid grid-cols-1 gap-2 text-[11px]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                    <div className="text-sm font-black text-slate-800 break-words">{selectedAttribute.targetAttributeId || '(unmapped attribute)'}</div>
                    <div className="text-[10px] text-slate-400">{selectedAttribute.attributeType || 'No type'}</div>
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] font-black uppercase tracking-wider text-slate-400">Original Values</div>
                    <div className="mt-1 text-slate-700 break-words">{joinValues(selectedOriginalValues)}</div>
                  </div>
                  <div>
                    <div className="text-[9px] font-black uppercase tracking-wider text-slate-400">Mapped Target Values</div>
                    <div className="mt-1 text-slate-700 break-words">{joinValues(selectedTargetValues)}</div>
                  </div>
                  <div>
                    <div className="text-[9px] font-black uppercase tracking-wider text-slate-400">Noise Values</div>
                    <div className="mt-1 text-slate-700 break-words">{joinValues(selectedNoiseValues)}</div>
                  </div>
                </div>
              ) : (
                <div className="mt-1 text-[11px] text-slate-400">Select an attribute to inspect values.</div>
              )}
            </div>

            <div className="px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[9px] font-black uppercase tracking-wider text-slate-500">Value Merge Suggestions</div>
                  <div className="text-[11px] text-slate-400">Original, target, and added values for the selected attribute.</div>
                </div>
                <div className="flex items-center gap-2">
                  {isValueMergeSaved ? <span className="inline-flex items-center px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[9px] font-bold uppercase">Saved</span> : null}
                  {valueDetail ? <div className="text-[10px] text-slate-400">{valueDetail.entries.length} rows</div> : null}
                  <button
                    type="button"
                    onClick={handleSaveValueMerge}
                    disabled={!selectedAttribute?.targetAttributeId || !valueDetail?.noiseValues.length || isSavingValue || isValueMergeSaved}
                    className="px-2.5 py-1 rounded-md bg-amber-600 text-white text-[9px] font-black uppercase tracking-wider hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {isSavingValue ? 'Saving...' : isValueMergeSaved ? 'Saved' : 'Save Value Merge'}
                  </button>
                </div>
              </div>

              {isLoadingValues ? (
                <div className="px-1 py-6 text-sm text-slate-400">Loading values...</div>
              ) : !valueDetail ? (
                <div className="px-1 py-6 text-sm text-slate-400">Select an attribute with a mapped target attribute to inspect value merges.</div>
              ) : (
                <div className="mt-3 space-y-3">
                  <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
                    <div className="text-[9px] font-black uppercase tracking-wider text-slate-400">Suggested Value Merge</div>
                    <div className="mt-1 text-[11px] text-slate-700">{valueDetail.noiseValues.length > 0 ? 'Value merge suggested for missing canonical values.' : 'No additional value merge suggested.'}</div>
                  </div>

                  <div>
                    <div className="text-[9px] font-black uppercase tracking-wider text-slate-400">Original Values</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {valueDetail.originalValues.length > 0 ? valueDetail.originalValues.map((value) => (
                        <span key={`orig-${value}`} className="inline-flex items-center px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-medium">{value}</span>
                      )) : <span className="text-[11px] text-slate-400">—</span>}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] font-black uppercase tracking-wider text-slate-400">Mapped Target Values</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {valueDetail.targetValues.length > 0 ? valueDetail.targetValues.map((value) => (
                        <span key={`target-${value}`} className="inline-flex items-center px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[10px] font-medium">{value}</span>
                      )) : <span className="text-[11px] text-slate-400">—</span>}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] font-black uppercase tracking-wider text-slate-400">Added / Noise Values</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {valueDetail.noiseValues.length > 0 ? valueDetail.noiseValues.map((value) => (
                        <span key={`noise-${value}`} className="inline-flex items-center px-2 py-0.5 rounded bg-amber-50 text-amber-700 text-[10px] font-medium">{value}</span>
                      )) : <span className="text-[11px] text-slate-400">—</span>}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 overflow-hidden">
                    <div className="px-3 py-2 border-b border-slate-200 bg-slate-50 text-[9px] font-black uppercase tracking-wider text-slate-500">Source Rows</div>
                    <div className="divide-y divide-slate-100">
                      {valueDetail.entries.map((row) => (
                        <div key={row.id} className="px-3 py-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="font-semibold text-[11px] text-slate-800">{row.legacyFeatureId}</div>
                            <span className={`px-2 py-0.5 rounded-full border text-[9px] font-black uppercase tracking-[0.15em] ${sourceTone[row.source] || sourceTone.original}`}>
                              {row.source.replace('_', ' ')}
                            </span>
                          </div>
                          <div className="mt-2 grid grid-cols-1 gap-1 text-[11px] text-slate-600">
                            <div><span className="font-bold text-slate-700">Original:</span> {joinValues(row.originalValues)}</div>
                            <div><span className="font-bold text-slate-700">Target:</span> {joinValues(row.targetValues)}</div>
                            <div><span className="font-bold text-slate-700">Noise:</span> {joinValues(row.noiseValues)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {showMergedView && selectedItem ? (
              <div className="px-4 py-3 border-t border-violet-200 bg-violet-50/30">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div>
                    <div className="text-[9px] font-black uppercase tracking-wider text-violet-600">Merged Workspace Mappings</div>
                    <div className="text-[11px] text-slate-400">Saved merge results for {selectedItem.itemId} — separate from original workspace mappings.</div>
                  </div>
                  <span className="text-[10px] text-violet-500 font-bold">{mergedMappings.length} row{mergedMappings.length !== 1 ? 's' : ''}</span>
                </div>
                {isLoadingMerged ? (
                  <div className="flex items-center justify-center gap-2 py-6 text-sm text-slate-400">
                    <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                    Loading merged mappings...
                  </div>
                ) : mergedMappings.length === 0 ? (
                  <div className="py-6 text-sm text-slate-400 text-center">No merged mappings saved yet for this item.</div>
                ) : (
                  <div className="rounded-xl border border-violet-200 overflow-hidden">
                    <table className="w-full text-[11px]">
                      <thead className="bg-violet-50">
                        <tr>
                          <th className="text-left px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-violet-500 border-b border-violet-200">Legacy Feature</th>
                          <th className="text-left px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-violet-500 border-b border-violet-200">New Attribute</th>
                          <th className="text-left px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-violet-500 border-b border-violet-200">Value</th>
                          <th className="text-left px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-violet-500 border-b border-violet-200">Type</th>
                          <th className="text-left px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-violet-500 border-b border-violet-200">Saved By</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-violet-100">
                        {mergedMappings.map((row) => (
                          <tr key={row.id} className="hover:bg-violet-50/50">
                            <td className="px-3 py-1.5 text-slate-700 font-medium">{row.legacyFeatureId}</td>
                            <td className="px-3 py-1.5 text-slate-700">{row.newAttributeId}</td>
                            <td className="px-3 py-1.5 text-slate-600">{row.newValue || '—'}</td>
                            <td className="px-3 py-1.5"><span className="px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 text-[9px] font-bold">{row.attributeType || '—'}</span></td>
                            <td className="px-3 py-1.5 text-slate-400">{row.signedOnByUsername || row.createdBy || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 text-[10px] text-slate-500 shrink-0">
            {total.toLocaleString()} items loaded
          </div>
        </div>
      </div>
    </div>
  );
};

export default MigrationManifest;