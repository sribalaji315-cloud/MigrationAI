import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { BomHierarchyItem, WorkspaceMappingRow, User } from '../types';
import { dbService } from '../services/dbService';
import { useCsvWorker } from '../hooks/useCsvWorker';

interface BOMHierarchyProps {
  currentUser: User;
  onClose: () => void;
}

interface TreeRow {
  key: string;
  depth: number;
  kind: 'root' | 'item';
  label: string;
  item?: BomHierarchyItem;
  expandable: boolean;
  expanded: boolean;
  childCount: number;
  variantCount: number;
}

const BOMHierarchy: React.FC<BOMHierarchyProps> = ({ currentUser, onClose }) => {
  const [allHierarchyItems, setAllHierarchyItems] = useState<BomHierarchyItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hasPendingUpload, setHasPendingUpload] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [existingBomIds, setExistingBomIds] = useState<Set<string>>(new Set());
  const [isCheckingBom, setIsCheckingBom] = useState(false);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [featureMappings, setFeatureMappings] = useState<WorkspaceMappingRow[]>([]);
  const [isLoadingFeatures, setIsLoadingFeatures] = useState(false);
  const [showFeatures, setShowFeatures] = useState(false);

  // Searchable BOM item selector
  const [bomSearch, setBomSearch] = useState('');
  const [bomSearchResults, setBomSearchResults] = useState<{ itemId: string; description: string }[]>([]);
  const [isBomSearching, setIsBomSearching] = useState(false);
  const [showBomDropdown, setShowBomDropdown] = useState(false);
  const [selectedBomItem, setSelectedBomItem] = useState<string | null>(null);
  const bomSearchRef = useRef<HTMLDivElement>(null);
  const bomSearchTimerRef = useRef<number | null>(null);

  const csvWorker = useCsvWorker();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isAdmin = currentUser.role === 'admin';

  const checkBomExistence = useCallback(async (items: BomHierarchyItem[]) => {
    setIsCheckingBom(true);
    try {
      const uniqueIds = Array.from(new Set(items.map(item => item.itemId).filter(Boolean)));
      if (!uniqueIds.length) {
        setExistingBomIds(new Set());
        return;
      }
      const bomItems = await dbService.fetchBomItemsByIds(uniqueIds);
      setExistingBomIds(new Set(bomItems.map(item => item.itemId)));
    } catch {
      setExistingBomIds(new Set());
    } finally {
      setIsCheckingBom(false);
    }
  }, []);

  const loadHierarchy = useCallback(async () => {
    setIsLoading(true);
    setStatusMessage(null);
    try {
      const result = await dbService.fetchBomHierarchy(10000, 0);
      setAllHierarchyItems(result.items);
      setTotalCount(result.total);
      setHasPendingUpload(false);
      setSelectedItemId(null);
      setSelectedRowKey(null);
      setShowFeatures(false);
      setFeatureMappings([]);
      await checkBomExistence(result.items);
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: `Failed to load hierarchy: ${err.message}` });
    } finally {
      setIsLoading(false);
    }
  }, [checkBomExistence]);

  // Load hierarchy for a specific BOM item by fetching its children recursively
  const loadHierarchyForItem = useCallback(async (itemId: string) => {
    setIsLoading(true);
    setStatusMessage(null);
    setSelectedBomItem(itemId);
    setBomSearch(itemId);
    setShowBomDropdown(false);
    try {
      // Fetch direct children and all descendants by walking the tree
      const allItems: BomHierarchyItem[] = [];
      const queue = [itemId];
      const visited = new Set<string>();
      while (queue.length > 0) {
        const parentId = queue.shift()!;
        if (visited.has(parentId)) continue;
        visited.add(parentId);
        const result = await dbService.fetchHierarchyChildren(parentId);
        for (const item of result.items) {
          allItems.push(item);
          // If this child is also a parent node, queue it for expansion
          queue.push(item.itemId);
        }
      }
      setAllHierarchyItems(allItems);
      setTotalCount(allItems.length);
      setHasPendingUpload(false);
      setSelectedItemId(null);
      setSelectedRowKey(null);
      setShowFeatures(false);
      setFeatureMappings([]);
      await checkBomExistence(allItems);
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: `Failed to load hierarchy for ${itemId}: ${err.message}` });
    } finally {
      setIsLoading(false);
    }
  }, [checkBomExistence]);

  // Debounced search for BOM items
  useEffect(() => {
    if (bomSearchTimerRef.current) window.clearTimeout(bomSearchTimerRef.current);
    const q = bomSearch.trim();
    if (!q) {
      setBomSearchResults([]);
      return;
    }
    setIsBomSearching(true);
    bomSearchTimerRef.current = window.setTimeout(async () => {
      try {
        const result = await dbService.searchBomHierarchyItems(q, 30);
        setBomSearchResults(result.items);
      } catch {
        setBomSearchResults([]);
      } finally {
        setIsBomSearching(false);
      }
    }, 300);
    return () => {
      if (bomSearchTimerRef.current) window.clearTimeout(bomSearchTimerRef.current);
    };
  }, [bomSearch]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (bomSearchRef.current && !bomSearchRef.current.contains(e.target as Node)) {
        setShowBomDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCsvUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setStatusMessage(null);
    setIsLoading(true);

    try {
      const text = await file.text();
      const rows = await csvWorker.parseCsvAsync(text);

      if (!rows.length) {
        setStatusMessage({ type: 'error', text: 'CSV file is empty or could not be parsed.' });
        return;
      }

      const ci = (row: Record<string, string>, ...keys: string[]): string => {
        for (const key of keys) {
          const normalizedKey = key.toLowerCase().replace(/[\s_]/g, '');
          for (const header of Object.keys(row)) {
            if (header.toLowerCase().replace(/[\s_]/g, '') === normalizedKey) {
              return (row[header] ?? '').trim();
            }
          }
        }
        return '';
      };

      const parsed = rows.map((row: Record<string, string>) => {
        const rawLevel = ci(row, 'level');
        const rawQty = ci(row, 'qty', 'quantity');
        return {
          level: rawLevel ? parseInt(rawLevel, 10) : undefined,
          parentBom: ci(row, 'bom', 'parentbom', 'parent bom', 'parent'),
          itemId: ci(row, 'bomitem', 'bom item', 'itemid', 'item_id', 'item id'),
          description: ci(row, 'description'),
          qty: rawQty ? parseFloat(rawQty) : undefined,
          unit: ci(row, 'unit', 'uom'),
          condition: ci(row, 'condition'),
          formula: ci(row, 'formula'),
          conversion: ci(row, 'conversion'),
        } satisfies BomHierarchyItem;
      }).filter(item => item.itemId);

      if (!parsed.length) {
        setStatusMessage({ type: 'error', text: 'No valid rows found. Ensure CSV has BOM and BoM item columns.' });
        return;
      }

      setAllHierarchyItems(parsed);
      setTotalCount(parsed.length);
      setHasPendingUpload(true);
      setSelectedItemId(null);
      setSelectedRowKey(null);
      setShowFeatures(false);
      setFeatureMappings([]);
      setStatusMessage({ type: 'success', text: `Parsed ${parsed.length} hierarchy rows from CSV.` });
      await checkBomExistence(parsed);
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: `CSV parse failed: ${err.message}` });
    } finally {
      setIsLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [checkBomExistence, csvWorker]);

  const handleSave = useCallback(async () => {
    if (!isAdmin || !allHierarchyItems.length) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const result = await dbService.saveBomHierarchy(allHierarchyItems);
      setHasPendingUpload(false);
      setStatusMessage({ type: 'success', text: `Saved ${result.rowsInserted} hierarchy rows to database.` });
      if (selectedBomItem) {
        await loadHierarchyForItem(selectedBomItem);
      } else {
        await loadHierarchy();
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: `Save failed: ${err.message}` });
    } finally {
      setIsSaving(false);
    }
  }, [allHierarchyItems, isAdmin, loadHierarchy, loadHierarchyForItem, selectedBomItem]);

  const handleViewFeatures = useCallback(async () => {
    if (!selectedItemId || !existingBomIds.has(selectedItemId)) return;
    setIsLoadingFeatures(true);
    setShowFeatures(true);
    try {
      const mappings = await dbService.fetchWorkspaceMappings(selectedItemId);
      setFeatureMappings(mappings);
    } catch (err: any) {
      setFeatureMappings([]);
      setStatusMessage({ type: 'error', text: `Failed to load features: ${err.message}` });
    } finally {
      setIsLoadingFeatures(false);
    }
  }, [existingBomIds, selectedItemId]);

  const childIds = useMemo(() => new Set(allHierarchyItems.map(item => item.itemId).filter(Boolean)), [allHierarchyItems]);
  const parentIds = useMemo(
    () => Array.from(new Set(allHierarchyItems.map(item => (item.parentBom || '').trim()).filter(Boolean))).sort(),
    [allHierarchyItems],
  );
  const rootNodeIds = useMemo(() => {
    const roots = parentIds.filter(parentId => !childIds.has(parentId));
    return roots.length ? roots : parentIds;
  }, [childIds, parentIds]);
  const childrenByParent = useMemo(() => {
    const grouped = new Map<string, BomHierarchyItem[]>();
    allHierarchyItems.forEach(item => {
      const parent = (item.parentBom || '').trim();
      if (!parent) return;
      const existing = grouped.get(parent) || [];
      existing.push(item);
      grouped.set(parent, existing);
    });
    // Deduplicate children by itemId within each parent, keeping first occurrence
    const deduped = new Map<string, BomHierarchyItem[]>();
    grouped.forEach((items, parent) => {
      const seen = new Set<string>();
      const unique: BomHierarchyItem[] = [];
      items.forEach(item => {
        if (!seen.has(item.itemId)) {
          seen.add(item.itemId);
          unique.push(item);
        }
      });
      deduped.set(parent, unique);
    });
    return deduped;
  }, [allHierarchyItems]);

  // Count how many rows exist per (parent, itemId) pair to show variant/condition count
  const variantCounts = useMemo(() => {
    const counts = new Map<string, number>();
    allHierarchyItems.forEach(item => {
      const parent = (item.parentBom || '').trim();
      if (!parent) return;
      const key = `${parent}|${item.itemId}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
  }, [allHierarchyItems]);
  // Collect all unique conditions per (parent, itemId) pair
  const conditionsByKey = useMemo(() => {
    const map = new Map<string, string[]>();
    allHierarchyItems.forEach(item => {
      const parent = (item.parentBom || '').trim();
      if (!parent) return;
      const key = `${parent}|${item.itemId}`;
      const list = map.get(key) || [];
      const cond = (item.condition || '').trim();
      if (cond && !list.includes(cond)) list.push(cond);
      map.set(key, list);
    });
    return map;
  }, [allHierarchyItems]);

  const parentNodeSet = useMemo(() => new Set(parentIds), [parentIds]);

  useEffect(() => {
    const defaultExpanded = new Set<string>();
    rootNodeIds.forEach(rootId => {
      defaultExpanded.add(`root:${rootId}`);
    });
    setExpandedNodes(defaultExpanded);
  }, [rootNodeIds.join('|')]);

  const treeRows = useMemo(() => {
    const rows: TreeRow[] = [];

    const appendChildren = (parentId: string, depth: number, path: string) => {
      const children = childrenByParent.get(parentId) || [];
      children.forEach((item, index) => {
        const rowKey = `${path}>${item.itemId}`;
        const childCount = (childrenByParent.get(item.itemId) || []).length;
        const expandable = childCount > 0;
        const expanded = expandedNodes.has(rowKey);
        const variants = variantCounts.get(`${parentId}|${item.itemId}`) || 1;
        rows.push({
          key: rowKey,
          depth,
          kind: 'item',
          label: item.itemId,
          item,
          expandable,
          expanded,
          childCount,
          variantCount: variants,
        });
        if (expandable && expanded) {
          appendChildren(item.itemId, depth + 1, rowKey);
        }
      });
    };

    rootNodeIds.forEach(rootId => {
      const rowKey = `root:${rootId}`;
      const childCount = (childrenByParent.get(rootId) || []).length;
      const expanded = expandedNodes.has(rowKey);
      rows.push({
        key: rowKey,
        depth: 0,
        kind: 'root',
        label: rootId,
        expandable: childCount > 0,
        expanded,
        childCount,
        variantCount: 1,
      });
      if (expanded) {
        appendChildren(rootId, 1, rowKey);
      }
    });

    return rows;
  }, [childrenByParent, expandedNodes, rootNodeIds]);

  const toggleNode = useCallback((rowKey: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(rowKey)) {
        next.delete(rowKey);
      } else {
        next.add(rowKey);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    const next = new Set<string>();
    const collect = (parentId: string, path: string) => {
      const children = childrenByParent.get(parentId) || [];
      children.forEach((item) => {
        const rowKey = `${path}>${item.itemId}`;
        if ((childrenByParent.get(item.itemId) || []).length > 0) {
          next.add(rowKey);
          collect(item.itemId, rowKey);
        }
      });
    };
    rootNodeIds.forEach(rootId => {
      const rootKey = `root:${rootId}`;
      next.add(rootKey);
      collect(rootId, rootKey);
    });
    setExpandedNodes(next);
  }, [childrenByParent, rootNodeIds]);

  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set());
  }, []);

  const selectedExists = selectedItemId ? existingBomIds.has(selectedItemId) : false;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <div className="flex items-center justify-between px-6 py-3 border-b border-slate-200 bg-white shrink-0">
        <div className="flex items-center gap-3">
          <div className="bg-violet-600 p-1.5 rounded-lg text-white shadow-md">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
            </svg>
          </div>
          <div>
            <h2 className="text-sm font-black text-slate-900 tracking-tight">BOM Hierarchy</h2>
            <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest">
              {totalCount} row{totalCount !== 1 ? 's' : ''}
              {rootNodeIds.length ? ` · ${rootNodeIds.length} root node${rootNodeIds.length !== 1 ? 's' : ''}` : ''}
              {hasPendingUpload && ' · Unsaved upload'}
              {isCheckingBom && ' · Checking BOM…'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isAdmin && (
            <label className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 text-slate-700 rounded-lg text-[9px] font-black uppercase tracking-widest cursor-pointer hover:bg-slate-50 transition-all">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Upload CSV
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={handleCsvUpload}
              />
            </label>
          )}

          {isAdmin && hasPendingUpload && (
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${
                isSaving
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow shadow-emerald-100'
              }`}
            >
              {isSaving ? 'Saving…' : 'Save to Database'}
            </button>
          )}

          <button
            type="button"
            onClick={handleViewFeatures}
            disabled={!selectedItemId || !selectedExists || isLoadingFeatures}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${
              !selectedItemId || !selectedExists
                ? 'bg-slate-100 text-slate-300 cursor-not-allowed'
                : isLoadingFeatures
                  ? 'bg-blue-100 text-blue-400 cursor-wait'
                  : 'bg-blue-600 text-white hover:bg-blue-700 shadow shadow-blue-100'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            {isLoadingFeatures ? 'Loading…' : 'View Features'}
          </button>

          <button
            type="button"
            onClick={expandAll}
            className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 text-[9px] font-black uppercase tracking-widest transition-colors"
          >
            Expand All
          </button>

          <button
            type="button"
            onClick={collapseAll}
            className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 text-[9px] font-black uppercase tracking-widest transition-colors"
          >
            Collapse All
          </button>

          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1 px-3 py-1.5 text-slate-400 hover:text-slate-700 text-[9px] font-black uppercase tracking-widest transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
            Close
          </button>
        </div>
      </div>

      {statusMessage && (
        <div className={`px-6 py-2 text-[10px] font-black uppercase tracking-widest ${
          statusMessage.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
        }`}>
          {statusMessage.text}
        </div>
      )}

      <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/60 flex flex-wrap items-center gap-6 text-[10px] font-bold uppercase tracking-widest text-slate-500 shrink-0">
          <div ref={bomSearchRef} className="relative">
            <div className="flex items-center gap-2">
              <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest whitespace-nowrap">Select BOM Item</label>
              <div className="relative">
                <input
                  type="text"
                  value={bomSearch}
                  onChange={(e) => {
                    setBomSearch(e.target.value);
                    setShowBomDropdown(true);
                    if (!e.target.value.trim()) {
                      setSelectedBomItem(null);
                      setAllHierarchyItems([]);
                      setTotalCount(0);
                    }
                  }}
                  onFocus={() => {
                    if (bomSearch.trim()) setShowBomDropdown(true);
                  }}
                  placeholder="Search by item ID or description..."
                  className="w-80 pl-8 pr-8 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all normal-case tracking-normal font-medium"
                />
                <svg className="w-3.5 h-3.5 absolute left-2.5 top-2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                {isBomSearching && (
                  <div className="absolute right-2.5 top-2">
                    <div className="w-3 h-3 border-2 border-violet-600 border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
                {bomSearch && !isBomSearching && (
                  <button
                    type="button"
                    onClick={() => {
                      setBomSearch('');
                      setSelectedBomItem(null);
                      setBomSearchResults([]);
                      setShowBomDropdown(false);
                      setAllHierarchyItems([]);
                      setTotalCount(0);
                      setExpandedNodes(new Set());
                    }}
                    className="absolute right-2.5 top-1.5 text-slate-400 hover:text-slate-700 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
            {showBomDropdown && bomSearchResults.length > 0 && (
              <div className="absolute top-full left-0 mt-1 w-[28rem] bg-white border border-slate-200 rounded-lg shadow-lg z-50 max-h-72 overflow-auto">
                {bomSearchResults.map((item) => (
                  <button
                    key={item.itemId}
                    type="button"
                    onClick={() => loadHierarchyForItem(item.itemId)}
                    className={`w-full text-left px-4 py-2.5 hover:bg-violet-50 transition-colors border-b border-slate-50 last:border-b-0 ${
                      selectedBomItem === item.itemId ? 'bg-violet-50' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-black text-slate-900 tracking-tight">{item.itemId}</span>
                      {item.description && (
                        <span className="text-[10px] text-slate-400 font-medium truncate">{item.description}</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {showBomDropdown && bomSearch.trim() && !isBomSearching && bomSearchResults.length === 0 && (
              <div className="absolute top-full left-0 mt-1 w-[28rem] bg-white border border-slate-200 rounded-lg shadow-lg z-50 px-4 py-3">
                <span className="text-[10px] text-slate-400 font-medium">No items found</span>
              </div>
            )}
          </div>
          {selectedBomItem && (
            <>
              <span>{totalCount} total imported rows</span>
              <span>{parentIds.length} BOM nodes</span>
              <span>{treeRows.filter(row => row.kind === 'item').length} visible item rows</span>
            </>
          )}
          <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-100 border border-emerald-200" />Exists in BOM</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-rose-100 border border-rose-200" />Not in BOM</span>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <div className="w-6 h-6 border-2 border-violet-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : !treeRows.length ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3">
            <svg className="w-12 h-12 text-slate-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
            </svg>
            <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest">No hierarchy rows</p>
            <p className="text-slate-300 text-[9px]">Search and select a BOM item above to view its hierarchy</p>
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest w-[34rem]">BOM Tree</th>
                <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest w-16 text-center">Level</th>
                <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest">Description</th>
                <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest w-20 text-center">Qty</th>
                <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest w-20 text-center">Unit</th>
                <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest min-w-[16rem]">Condition</th>
                <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest w-32">Formula</th>
                <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest min-w-[14rem]">Feature Conversion</th>
                <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest w-28 text-center">Type</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {treeRows.map(row => {
                if (row.kind === 'root') {
                  return (
                    <tr key={row.key} className="bg-slate-100/80 hover:bg-slate-200/60 transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleNode(row.key)}
                            className="w-6 h-6 inline-flex items-center justify-center rounded-md hover:bg-white/70 text-slate-600"
                          >
                            <svg className={`w-4 h-4 transition-transform ${row.expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                            </svg>
                          </button>
                          <span className="text-[10px] font-black text-slate-900 tracking-tight">{row.label}</span>
                          <span className="px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 text-[7px] font-black uppercase tracking-widest">
                            {row.childCount} child{row.childCount !== 1 ? 'ren' : ''}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-center"><span className="text-[10px] font-black text-slate-500">ROOT</span></td>
                      <td className="px-4 py-2.5"><span className="text-[9px] text-slate-400">Top-level BOM assembly</span></td>
                      <td className="px-4 py-2.5 text-center"><span className="text-[10px] text-slate-400">—</span></td>
                      <td className="px-4 py-2.5 text-center"><span className="text-[10px] text-slate-400">—</span></td>
                      <td className="px-4 py-2.5"><span className="text-[9px] text-slate-400">—</span></td>
                      <td className="px-4 py-2.5"><span className="text-[9px] text-slate-400">—</span></td>
                      <td className="px-4 py-2.5"><span className="text-[9px] text-slate-400">—</span></td>
                      <td className="px-4 py-2.5 text-center">
                        <span className="text-[8px] font-black uppercase tracking-widest text-violet-600">Node</span>
                      </td>
                    </tr>
                  );
                }

                const item = row.item!;
                const exists = existingBomIds.has(item.itemId);
                const isSelected = selectedRowKey === row.key;
                const isNode = parentNodeSet.has(item.itemId);
                const rowBg = exists
                  ? isSelected ? 'bg-emerald-100' : 'bg-emerald-50/60'
                  : isSelected ? 'bg-rose-100' : 'bg-rose-50/60';

                return (
                  <tr
                    key={row.key}
                    className={`cursor-pointer transition-colors hover:opacity-90 ${rowBg}`}
                    onClick={() => {
                      setSelectedRowKey(row.key);
                      setSelectedItemId(item.itemId);
                      setShowFeatures(false);
                      setFeatureMappings([]);
                    }}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2" style={{ paddingLeft: `${Math.max(0, row.depth - 1) * 20}px` }}>
                        {row.expandable ? (
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation();
                              toggleNode(row.key);
                            }}
                            className="w-6 h-6 inline-flex items-center justify-center rounded-md hover:bg-white/70 text-slate-600 shrink-0"
                          >
                            <svg className={`w-4 h-4 transition-transform ${row.expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                            </svg>
                          </button>
                        ) : (
                          <span className="w-6 h-6 shrink-0" />
                        )}
                        <span className={`w-2 h-2 rounded-full shrink-0 ${exists ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-black text-slate-900 tracking-tight">{item.itemId}</span>
                            {isNode && (
                              <span className="px-1.5 py-0.5 rounded-full bg-slate-900 text-white text-[7px] font-black uppercase tracking-widest">
                                BOM Node
                              </span>
                            )}
                            {(() => {
                              const parentKey = `${(item.parentBom || '').trim()}|${item.itemId}`;
                              const condCount = (conditionsByKey.get(parentKey) || []).length;
                              return condCount > 1 ? (
                                <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[7px] font-black uppercase tracking-widest">
                                  {condCount} conditions
                                </span>
                              ) : null;
                            })()}
                          </div>
                          <div className="text-[8px] font-bold uppercase tracking-widest text-slate-400">
                            Parent {item.parentBom || '—'}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className="text-[10px] font-black text-slate-600">{row.depth}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-[9px] text-slate-600 font-medium line-clamp-1">{item.description || '—'}</span>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className="text-[10px] text-slate-600 font-medium">{item.qty ?? '—'}</span>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className="text-[10px] text-slate-500 font-medium">{item.unit || '—'}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      {(() => {
                        const parentKey = `${(item.parentBom || '').trim()}|${item.itemId}`;
                        const allConds = conditionsByKey.get(parentKey) || [];
                        if (!allConds.length) return <span className="text-[9px] text-slate-400">—</span>;
                        return (
                          <div className="space-y-1">
                            {allConds.map((cond, ci) => (
                              <div key={ci} className="text-[9px] text-indigo-600 font-medium whitespace-pre-wrap break-words">{cond}</div>
                            ))}
                          </div>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-[9px] text-purple-600 font-medium line-clamp-1">{item.formula || '—'}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      {item.conversion ? (
                        <span className="text-[9px] text-teal-600 font-medium whitespace-pre-wrap break-words">{item.conversion}</span>
                      ) : (
                        <span className="text-[9px] text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {row.expandable ? (
                        <span className="text-[8px] font-black uppercase tracking-widest text-violet-600">
                          {row.expanded ? 'Expanded' : 'Collapsed'}
                        </span>
                      ) : (
                        <span className="text-[8px] font-black uppercase tracking-widest text-slate-300">Leaf</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showFeatures && (
        <div className="border-t border-slate-200 bg-slate-50 shrink-0 max-h-[40vh] overflow-auto">
          <div className="flex items-center justify-between px-6 py-2 border-b border-slate-100 bg-white sticky top-0 z-10">
            <div className="flex items-center gap-2">
              <h3 className="text-[10px] font-black text-slate-700 uppercase tracking-widest">
                Workspace Mappings for {selectedItemId}
              </h3>
              <span className="px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[8px] font-black">
                {featureMappings.length} row{featureMappings.length !== 1 ? 's' : ''}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowFeatures(false);
                setFeatureMappings([]);
              }}
              className="text-slate-400 hover:text-slate-700 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {isLoadingFeatures ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : featureMappings.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest">No workspace mappings found</p>
            </div>
          ) : (
            <table className="w-full text-left">
              <thead className="sticky top-[41px] bg-slate-50 border-b border-slate-200 z-10">
                <tr>
                  <th className="px-4 py-2 text-[8px] font-black text-slate-400 uppercase tracking-widest">Feature ID</th>
                  <th className="px-4 py-2 text-[8px] font-black text-slate-400 uppercase tracking-widest">Legacy Value</th>
                  <th className="px-4 py-2 text-[8px] font-black text-slate-400 uppercase tracking-widest">Target Attribute</th>
                  <th className="px-4 py-2 text-[8px] font-black text-slate-400 uppercase tracking-widest">All Targets</th>
                  <th className="px-4 py-2 text-[8px] font-black text-slate-400 uppercase tracking-widest">Target Value</th>
                  <th className="px-4 py-2 text-[8px] font-black text-slate-400 uppercase tracking-widest">Condition</th>
                  <th className="px-4 py-2 text-[8px] font-black text-slate-400 uppercase tracking-widest">Formula</th>
                  <th className="px-4 py-2 text-[8px] font-black text-slate-400 uppercase tracking-widest w-24 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {featureMappings.map((mapping, idx) => {
                  const isMapped = mapping.newAttributeId && mapping.newAttributeId !== 'UNMAPPED';
                  const isNotRequired = mapping.newAttributeId === 'NOT REQUIRED';
                  const statusTone = isNotRequired
                    ? 'bg-amber-100 text-amber-700'
                    : isMapped
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-rose-100 text-rose-700';
                  const statusLabel = isNotRequired ? 'N/R' : isMapped ? 'Mapped' : 'Unmapped';

                  return (
                    <tr key={`${mapping.legacyFeatureId}-${mapping.legacyValue}-${idx}`} className="bg-white hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-2"><span className="text-[9px] font-black text-slate-900">{mapping.legacyFeatureId}</span></td>
                      <td className="px-4 py-2"><span className="text-[9px] font-medium text-slate-600">{mapping.legacyValue || '—'}</span></td>
                      <td className="px-4 py-2"><span className="text-[9px] font-black text-blue-700">{mapping.newAttributeId}</span></td>
                      <td className="px-4 py-2">
                        {mapping.allGlobalTargets && mapping.allGlobalTargets.length > 0 ? (
                          <span className={`text-[9px] font-medium ${mapping.mappedFrom !== 'global' ? 'text-orange-600' : 'text-violet-600'}`}>
                            {mapping.mappedFrom !== 'global' ? `⚡ ${mapping.allGlobalTargets.join('; ')}` : mapping.allGlobalTargets.join('; ')}
                          </span>
                        ) : (
                          <span className="text-[9px] font-medium text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2"><span className="text-[9px] font-medium text-slate-600">{mapping.newValue || '—'}</span></td>
                      <td className="px-4 py-2"><span className="text-[9px] font-medium text-indigo-600">{mapping.condition || '—'}</span></td>
                      <td className="px-4 py-2"><span className="text-[9px] font-medium text-purple-600">{mapping.formula || '—'}</span></td>
                      <td className="px-4 py-2 text-center">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-[7px] font-black uppercase tracking-widest ${statusTone}`}>
                          {statusLabel}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
};

export default BOMHierarchy;
