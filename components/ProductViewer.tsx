import React, { useState, useEffect, useCallback, useMemo, useRef, useTransition } from 'react';
import { List, useDynamicRowHeight, type RowComponentProps } from 'react-window';
import { LegacyItem, User, WorkspaceMappingRow, ItemApprovalState } from '../types';
import { dbService } from '../services/dbService';
import { buildCsv } from '../utils/csvHelpers';

interface ProductViewerProps {
  currentUser: User;
  onClose: () => void;
}

const PAGE_SIZE = 20;

const feasibilityTone = (raw?: string | null): string => {
  const v = (raw || '').trim().toLowerCase();
  if (v === 'yes' || v === 'feasible') return 'bg-emerald-100 text-emerald-700 border-emerald-200';
  if (v === 'no' || v === 'infeasible') return 'bg-rose-100 text-rose-700 border-rose-200';
  if (v === 'review') return 'bg-amber-100 text-amber-700 border-amber-200';
  if (v === 'conditional') return 'bg-violet-100 text-violet-700 border-violet-200';
  return 'bg-slate-100 text-slate-600 border-slate-200';
};

const valueStatusTone = (raw?: string | null): string => {
  const v = (raw || '').trim().toLowerCase();
  if (v === 'discontinued') return 'bg-rose-100 text-rose-700 border-rose-200';
  if (v === 'deprecated') return 'bg-orange-100 text-orange-700 border-orange-200';
  if (v === 'ignored') return 'bg-slate-100 text-slate-600 border-slate-200';
  return 'bg-slate-100 text-slate-600 border-slate-200';
};

const formatApprovalTitle = (by?: string | null, at?: number | null): string | undefined => {
  if (!by && !at) return undefined;
  const parts: string[] = [];
  if (by) parts.push(`Approved by ${by}`);
  if (at) parts.push(new Date(at < 1e12 ? at * 1000 : at).toLocaleString());
  return parts.join(' • ');
};

interface MultiSelectFilterProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}

const MultiSelectFilter: React.FC<MultiSelectFilterProps> = ({ label, options, selected, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (opt: string) => {
    if (selected.includes(opt)) onChange(selected.filter(o => o !== opt));
    else onChange([...selected, opt]);
  };

  const active = selected.length > 0;
  const summary = active ? `${label} (${selected.length})` : label;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1 px-2 py-1 border rounded-md text-[10px] font-bold outline-none transition-colors ${
          active ? 'border-sky-400 bg-sky-50 text-sky-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
        }`}
      >
        <span>{summary}</span>
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-52 max-h-64 overflow-y-auto bg-white border border-slate-200 rounded-md shadow-lg py-1">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-[10px] text-slate-400 font-medium">No options</div>
          ) : (
            <>
              {active && (
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="w-full text-left px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-slate-400 hover:bg-slate-50 border-b border-slate-100"
                >
                  Clear selection
                </button>
              )}
              {options.map(opt => (
                <label key={opt} className="flex items-center gap-2 px-3 py-1.5 text-[10px] text-slate-600 hover:bg-slate-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.includes(opt)}
                    onChange={() => toggle(opt)}
                    className="w-3 h-3 rounded border-slate-300 text-sky-600 focus:ring-sky-400"
                  />
                  <span className="truncate font-medium">{opt}</span>
                </label>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
};

interface FeatureGroup {
  legacyFeatureId: string;
  description: string;
  rows: WorkspaceMappingRow[];
}

type ConditionTranslationMap = Record<string, { attr: string; value: string }>;

// Rewrites source condition tokens (e.g. `.*AGNI = 'NI002'`) into target
// attribute/value tokens using only the current item's mappings. Tokens without
// a matching mapping are left unchanged. Operators, parentheses and whitespace
// are preserved because only the matched tokens are replaced.
const CONDITION_TOKEN_RE = /(\.\*)?([A-Za-z_][A-Za-z0-9_]*)\s*(=|<>)\s*'([^']*)'/g;

type ConditionSegment = { text: string; kind: 'plain' | 'translated' | 'legacy' };

// Splits a condition into segments: attribute/value tokens that resolve to a
// target become 'translated', tokens without a target mapping stay 'legacy',
// and operators/parentheses/whitespace are 'plain'.
const buildConditionSegments = (condition: string, map: ConditionTranslationMap): ConditionSegment[] => {
  const segments: ConditionSegment[] = [];
  let lastIndex = 0;
  CONDITION_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONDITION_TOKEN_RE.exec(condition)) !== null) {
    const [full, , ident, op, value] = m;
    if (m.index > lastIndex) {
      segments.push({ text: condition.slice(lastIndex, m.index), kind: 'plain' });
    }
    const target = map[`${ident}|${value}`];
    if (target) {
      segments.push({ text: `${target.attr} ${op} '${target.value}'`, kind: 'translated' });
    } else {
      segments.push({ text: full, kind: 'legacy' });
    }
    lastIndex = m.index + full.length;
  }
  if (lastIndex < condition.length) {
    segments.push({ text: condition.slice(lastIndex), kind: 'plain' });
  }
  return segments;
};

// --- Virtualized mapping list (react-window) -------------------------------
// Dynamic row heights so long conditions can wrap and display fully.
const DEFAULT_ROW_HEIGHT = 30;

type FlatMappingItem =
  | { kind: 'header'; group: FeatureGroup }
  | { kind: 'row'; row: WorkspaceMappingRow; isLast: boolean };

interface MappingRowProps {
  items: FlatMappingItem[];
  translateConditions: boolean;
  conditionSegmentsByRow: Map<WorkspaceMappingRow, ConditionSegment[]>;
  approvalState: ItemApprovalState | null;
}

const DASH = <span className="text-slate-300">—</span>;

const MappingListRow = ({ index, style, items, translateConditions, conditionSegmentsByRow, approvalState }: RowComponentProps<MappingRowProps>) => {
  const item = items[index];

  if (item.kind === 'header') {
    const group = item.group;
    const fa = approvalState?.features?.[group.legacyFeatureId];
    const approved = !!fa;
    const attributeType = group.rows[0]?.attributeType;
    return (
      <div style={style} className="px-4">
        <div className="pt-3">
          <div className="bg-slate-50 border-x border-t border-slate-200 rounded-t-lg px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-black text-slate-800 tracking-tight">{group.legacyFeatureId}</span>
              {attributeType && (
                <span className="px-1.5 py-0.5 rounded-[3px] text-[7px] font-black uppercase bg-slate-200 text-slate-500">{attributeType}</span>
              )}
              <span
                title={approved ? formatApprovalTitle(fa?.approvedByUsername, fa?.approvedAt) : undefined}
                className={`ml-auto px-1.5 py-0.5 rounded-[3px] text-[7px] font-black uppercase border ${
                  approved
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-slate-100 text-slate-500 border-slate-200'
                }`}
              >
                {approved ? 'Approved' : 'Pending'}
              </span>
            </div>
            {group.description && <p className="text-[10px] text-slate-400 font-medium mt-0.5">{group.description}</p>}
          </div>
        </div>
      </div>
    );
  }

  const row = item.row;
  const segments = translateConditions && row.condition ? conditionSegmentsByRow.get(row) : undefined;
  return (
    <div style={style} className="px-4">
      <div className={`grid grid-cols-6 items-start gap-1 bg-white border-x border-slate-200 text-[11px] py-1.5 ${item.isLast ? 'border-b rounded-b-lg' : 'border-b border-slate-50'}`}>
        <div className="px-4 min-w-0 font-bold text-slate-700 break-words">{row.legacyValue || DASH}</div>
        <div className="px-3 min-w-0 text-slate-600 break-words">{row.newAttributeId || DASH}</div>
        <div className="px-3 min-w-0 text-slate-600 break-words">{row.newValue || DASH}</div>
        <div className="px-3 min-w-0 break-words text-slate-500">
          {!row.condition
            ? DASH
            : segments
              ? segments.map((seg, i) => (
                  <span
                    key={i}
                    className={seg.kind === 'translated'
                      ? 'text-emerald-600 font-semibold'
                      : seg.kind === 'legacy'
                        ? 'text-rose-600 font-semibold'
                        : 'text-slate-500'}
                  >
                    {seg.text}
                  </span>
                ))
              : row.condition}
        </div>
        <div className="px-3 min-w-0">
          {row.feasibility ? (
            <span className={`inline-block px-1.5 py-0.5 rounded-[3px] text-[8px] font-black uppercase border ${feasibilityTone(row.feasibility)}`}>{row.feasibility}</span>
          ) : DASH}
        </div>
        <div className="px-3 min-w-0">
          {row.valueStatus ? (
            <span className={`inline-block px-1.5 py-0.5 rounded-[3px] text-[8px] font-black uppercase border ${valueStatusTone(row.valueStatus)}`}>{row.valueStatus}</span>
          ) : DASH}
        </div>
      </div>
    </div>
  );
};

const ProductViewer: React.FC<ProductViewerProps> = ({ currentUser, onClose }) => {
  void currentUser;

  // Left pane: product list + filters
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [category, setCategory] = useState('');
  const [productType, setProductType] = useState('');
  const [priority, setPriority] = useState('');
  const [page, setPage] = useState(0);

  const [items, setItems] = useState<LegacyItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoadingItems, setIsLoadingItems] = useState(false);

  const [filterOptions, setFilterOptions] = useState<{ categories: string[]; productTypes: string[]; priorities: number[] }>({
    categories: [],
    productTypes: [],
    priorities: [],
  });

  // Right pane: selected product + its mappings
  const [selectedItem, setSelectedItem] = useState<LegacyItem | null>(null);
  const [mappingRows, setMappingRows] = useState<WorkspaceMappingRow[]>([]);
  const [isLoadingMappings, setIsLoadingMappings] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [approvalState, setApprovalState] = useState<ItemApprovalState | null>(null);

  // Right pane: translate condition source tokens into target attribute/value tokens
  const [translateConditions, setTranslateConditions] = useState(false);
  const [isTranslating, startTranslationTransition] = useTransition();

  // Right pane: mapping-level filters (multi-select)
  const [filterLegacyAttributes, setFilterLegacyAttributes] = useState<string[]>([]);
  const [filterAttributeTypes, setFilterAttributeTypes] = useState<string[]>([]);
  const [filterFeasibilities, setFilterFeasibilities] = useState<string[]>([]);
  const [filterValueStatuses, setFilterValueStatuses] = useState<string[]>([]);

  const loadGenRef = useRef(0);

  // Load filter options once
  useEffect(() => {
    dbService.fetchBomFilters()
      .then(setFilterOptions)
      .catch(err => console.warn('Failed to fetch BOM filters', err));
  }, []);

  const loadItems = useCallback(async () => {
    const gen = ++loadGenRef.current;
    setIsLoadingItems(true);
    try {
      const priorityNum = priority ? Number(priority) : undefined;
      const [result, count] = await Promise.all([
        dbService.fetchSignedOnBomItems({
          category: category || undefined,
          productType: productType || undefined,
          search: search || undefined,
          priority: priorityNum,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
        dbService.fetchBomCount(
          category || undefined,
          productType || undefined,
          search || undefined,
          priorityNum,
        ),
      ]);
      if (gen !== loadGenRef.current) return;
      setItems(result.items);
      setTotalCount(count);
    } catch (err) {
      if (gen !== loadGenRef.current) return;
      console.warn('Failed to load products', err);
      setItems([]);
      setTotalCount(0);
    } finally {
      if (gen === loadGenRef.current) setIsLoadingItems(false);
    }
  }, [category, productType, priority, search, page]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const handleSelectItem = useCallback(async (item: LegacyItem) => {
    setSelectedItem(item);
    setStatusMessage(null);
    setFilterLegacyAttributes([]);
    setFilterAttributeTypes([]);
    setFilterFeasibilities([]);
    setFilterValueStatuses([]);
    setApprovalState(null);
    setIsLoadingMappings(true);
    setMappingRows([]);
    try {
      const [rows, approval] = await Promise.all([
        dbService.fetchWorkspaceMappings(item.itemId),
        dbService.fetchItemApprovalState(item.itemId).catch(err => {
          console.warn('Failed to load approval state for', item.itemId, err);
          return null;
        }),
      ]);
      setMappingRows(rows);
      setApprovalState(approval);
    } catch (err) {
      console.warn('Failed to load mappings for', item.itemId, err);
      setStatusMessage({ type: 'error', text: 'Failed to load mappings for this product.' });
    } finally {
      setIsLoadingMappings(false);
    }
  }, []);

  // Distinct option lists for the right-pane filters
  const mappingFilterOptions = useMemo(() => {
    const legacyAttributes = new Set<string>();
    const attributeTypes = new Set<string>();
    const feasibilities = new Set<string>();
    const valueStatuses = new Set<string>();
    for (const row of mappingRows) {
      if (row.legacyFeatureId) legacyAttributes.add(row.legacyFeatureId);
      if (row.attributeType) attributeTypes.add(row.attributeType);
      if (row.feasibility) feasibilities.add(row.feasibility);
      if (row.valueStatus) valueStatuses.add(row.valueStatus);
    }
    return {
      legacyAttributes: Array.from(legacyAttributes).sort((a, b) => a.localeCompare(b)),
      attributeTypes: Array.from(attributeTypes).sort((a, b) => a.localeCompare(b)),
      feasibilities: Array.from(feasibilities).sort((a, b) => a.localeCompare(b)),
      valueStatuses: Array.from(valueStatuses).sort((a, b) => a.localeCompare(b)),
    };
  }, [mappingRows]);

  // Apply the right-pane filters to the raw mapping rows
  const filteredMappingRows = useMemo(() => {
    return mappingRows.filter(row => {
      if (filterLegacyAttributes.length && !filterLegacyAttributes.includes(row.legacyFeatureId)) return false;
      if (filterAttributeTypes.length && !filterAttributeTypes.includes(row.attributeType || '')) return false;
      if (filterFeasibilities.length && !filterFeasibilities.includes(row.feasibility || '')) return false;
      if (filterValueStatuses.length && !filterValueStatuses.includes(row.valueStatus || '')) return false;
      return true;
    });
  }, [mappingRows, filterLegacyAttributes, filterAttributeTypes, filterFeasibilities, filterValueStatuses]);

  // Group mapping rows by legacy feature for the right pane
  const featureGroups = useMemo<FeatureGroup[]>(() => {
    const descByFeature: Record<string, string> = {};
    if (selectedItem?.features) {
      for (const f of selectedItem.features) {
        descByFeature[f.featureId] = f.description || '';
      }
    }
    const order: string[] = [];
    const map: Record<string, WorkspaceMappingRow[]> = {};
    for (const row of filteredMappingRows) {
      if (!map[row.legacyFeatureId]) {
        map[row.legacyFeatureId] = [];
        order.push(row.legacyFeatureId);
      }
      map[row.legacyFeatureId].push(row);
    }
    return order.map(fid => ({
      legacyFeatureId: fid,
      description: descByFeature[fid] || '',
      rows: map[fid],
    }));
  }, [filteredMappingRows, selectedItem]);

  // Map of `${legacyFeatureId}|${legacyValue}` -> target attribute/value, built
  // only from the current item's mappings.
  const conditionTranslationMap = useMemo<ConditionTranslationMap>(() => {
    const map: ConditionTranslationMap = {};
    for (const row of mappingRows) {
      if (!row.legacyFeatureId || !row.legacyValue || !row.newAttributeId || !row.newValue) continue;
      const key = `${row.legacyFeatureId}|${row.legacyValue}`;
      if (!map[key]) map[key] = { attr: row.newAttributeId, value: row.newValue };
    }
    return map;
  }, [mappingRows]);

  // Precompute condition segments once (keyed by row reference) so toggling and
  // scrolling stay instant. Translated tokens are green, untranslated legacy
  // tokens are red, operators/parentheses neutral.
  const conditionSegmentsByRow = useMemo(() => {
    const map = new Map<WorkspaceMappingRow, ConditionSegment[]>();
    for (const row of mappingRows) {
      if (row.condition) map.set(row, buildConditionSegments(row.condition, conditionTranslationMap));
    }
    return map;
  }, [mappingRows, conditionTranslationMap]);

  // Flatten grouped rows into a single list for virtualization (react-window).
  const flatMappingItems = useMemo<FlatMappingItem[]>(() => {
    const flat: FlatMappingItem[] = [];
    for (const group of featureGroups) {
      flat.push({ kind: 'header', group });
      group.rows.forEach((row, idx) => {
        flat.push({ kind: 'row', row, isLast: idx === group.rows.length - 1 });
      });
    }
    return flat;
  }, [featureGroups]);

  // Dynamic row heights let long conditions wrap and display fully. The key
  // resets cached measurements when the underlying list changes.
  const rowHeightCache = useDynamicRowHeight({
    defaultRowHeight: DEFAULT_ROW_HEIGHT,
    key: `${selectedItem?.itemId ?? ''}|${flatMappingItems.length}|${translateConditions ? 't' : 'f'}`,
  });

  const hasMappingFilters = !!(filterLegacyAttributes.length || filterAttributeTypes.length || filterFeasibilities.length || filterValueStatuses.length);
  const clearMappingFilters = () => {
    setFilterLegacyAttributes([]);
    setFilterAttributeTypes([]);
    setFilterFeasibilities([]);
    setFilterValueStatuses([]);
  };

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(0);
    setSearch(searchInput.trim());
  };

  const resetToPageZero = () => setPage(0);

  const handleExportCsv = () => {
    if (!selectedItem) return;
    const header = [
      'Item ID',
      'Description',
      'Legacy Attribute',
      'Legacy Value',
      'Target Attribute',
      'Target Value',
      'Attribute Type',
      'Condition',
      ...(translateConditions ? ['Translated Condition'] : []),
      'Feasibility',
      'Value Status',
    ];
    const rows: string[][] = [header];
    for (const r of mappingRows) {
      rows.push([
        selectedItem.itemId,
        selectedItem.description || '',
        r.legacyFeatureId || '',
        r.legacyValue || '',
        r.newAttributeId || '',
        r.newValue || '',
        r.attributeType || '',
        r.condition || '',
        ...(translateConditions ? [conditionSegmentsByRow.get(r)?.map(s => s.text).join('') ?? (r.condition || '')] : []),
        r.feasibility || '',
        r.valueStatus || '',
      ]);
    }
    const csv = buildCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `product-${selectedItem.itemId}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatusMessage({ type: 'success', text: `Exported ${mappingRows.length} mapping rows.` });
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-50 flex flex-col overflow-hidden">
      {/* Top bar */}
      <header className="bg-white border-b border-slate-200 px-5 py-2.5 flex items-center justify-between shrink-0 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="bg-sky-600 p-1.5 rounded-lg text-white shadow-md">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-black text-slate-900 leading-none tracking-tight">Product Viewer</h1>
            <p className="text-[9px] text-slate-400 uppercase tracking-widest font-bold mt-0.5">Source &rarr; Target Mappings</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => startTranslationTransition(() => setTranslateConditions(v => !v))}
            aria-pressed={translateConditions}
            aria-busy={isTranslating}
            title="Translate condition source tokens into target attribute/value tokens"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[9px] font-black uppercase tracking-wider transition-all border ${
              translateConditions
                ? 'bg-sky-600 text-white border-sky-600 hover:bg-sky-700'
                : 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200'
            }`}
          >
            {isTranslating ? (
              <span className={`w-2.5 h-2.5 border-2 rounded-full animate-spin ${translateConditions ? 'border-white/40 border-t-white' : 'border-slate-300 border-t-slate-500'}`} />
            ) : (
              <span className={`w-2 h-2 rounded-full ${translateConditions ? 'bg-white' : 'bg-slate-400'}`} />
            )}
            Translate Conditions
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={!selectedItem || mappingRows.length === 0}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[9px] font-black uppercase tracking-wider transition-all border ${
              selectedItem && mappingRows.length > 0
                ? 'bg-emerald-50 text-emerald-700 border-emerald-100 hover:bg-emerald-100'
                : 'bg-slate-50 text-slate-300 border-slate-100 cursor-not-allowed'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Export CSV
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200 rounded-md text-[9px] font-black uppercase tracking-wider transition-all"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            Close
          </button>
        </div>
      </header>

      {statusMessage && (
        <div className={`px-5 py-1.5 text-[10px] font-black uppercase tracking-widest shrink-0 ${
          statusMessage.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
        }`}>
          {statusMessage.text}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left pane: filters + product list */}
        <aside className="w-80 shrink-0 border-r border-slate-200 bg-white flex flex-col">
          <form onSubmit={handleSearchSubmit} className="p-3 border-b border-slate-100 space-y-2">
            <div className="flex gap-1.5">
              <input
                type="text"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder="Search product id or description…"
                className="flex-1 px-2.5 py-1.5 border border-slate-200 rounded-md text-[11px] focus:ring-1 focus:ring-sky-400 focus:border-sky-400 outline-none"
              />
              <button
                type="submit"
                className="px-2.5 py-1.5 bg-sky-600 text-white rounded-md text-[10px] font-black uppercase tracking-wider hover:bg-sky-700 transition-colors"
              >
                Go
              </button>
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              <select
                value={category}
                onChange={e => { setCategory(e.target.value); resetToPageZero(); }}
                className="px-2 py-1.5 border border-slate-200 rounded-md text-[11px] bg-white focus:ring-1 focus:ring-sky-400 outline-none"
              >
                <option value="">All Categories</option>
                {filterOptions.categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select
                value={productType}
                onChange={e => { setProductType(e.target.value); resetToPageZero(); }}
                className="px-2 py-1.5 border border-slate-200 rounded-md text-[11px] bg-white focus:ring-1 focus:ring-sky-400 outline-none"
              >
                <option value="">All Product Types</option>
                {filterOptions.productTypes.map(pt => <option key={pt} value={pt}>{pt}</option>)}
              </select>
              <select
                value={priority}
                onChange={e => { setPriority(e.target.value); resetToPageZero(); }}
                className="px-2 py-1.5 border border-slate-200 rounded-md text-[11px] bg-white focus:ring-1 focus:ring-sky-400 outline-none"
              >
                <option value="">All Priorities</option>
                {filterOptions.priorities.map(p => <option key={p} value={String(p)}>Priority {p}</option>)}
              </select>
            </div>
          </form>

          <div className="flex-1 overflow-y-auto">
            {isLoadingItems ? (
              <div className="flex items-center justify-center py-10">
                <div className="w-5 h-5 border-2 border-sky-600 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : items.length === 0 ? (
              <div className="px-4 py-10 text-center text-[11px] text-slate-400 font-medium">No products found.</div>
            ) : (
              items.map(item => {
                const isSelected = selectedItem?.itemId === item.itemId;
                return (
                  <button
                    key={item.itemId}
                    onClick={() => handleSelectItem(item)}
                    className={`w-full text-left px-4 py-2.5 border-b border-slate-50 transition-all ${
                      isSelected ? 'bg-sky-50 border-l-[3px] border-l-sky-600' : 'hover:bg-slate-50 border-l-[3px] border-l-transparent'
                    }`}
                  >
                    <p className={`text-xs font-black truncate tracking-tight ${isSelected ? 'text-sky-900' : 'text-slate-900'}`}>{item.itemId}</p>
                    <p className="text-[10px] text-slate-400 line-clamp-1 font-medium mt-0.5">{item.description}</p>
                    <div className="flex items-center gap-1 mt-1">
                      {item.category && <span className="px-1.5 py-0.5 rounded-[3px] text-[7px] font-black uppercase bg-slate-100 text-slate-500">{item.category}</span>}
                      {item.productType && <span className="px-1.5 py-0.5 rounded-[3px] text-[7px] font-black uppercase bg-indigo-50 text-indigo-500">{item.productType}</span>}
                      {item.priority != null && <span className="px-1.5 py-0.5 rounded-[3px] text-[7px] font-black uppercase bg-amber-50 text-amber-600">P{item.priority}</span>}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Pagination */}
          <div className="border-t border-slate-100 px-3 py-2 flex items-center justify-between shrink-0">
            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
              {totalCount} item{totalCount === 1 ? '' : 's'}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-2 py-1 rounded text-[9px] font-black uppercase tracking-wider bg-slate-100 text-slate-600 disabled:text-slate-300 disabled:cursor-not-allowed hover:bg-slate-200"
              >
                Prev
              </button>
              <span className="text-[9px] font-black text-slate-500 px-1">{page + 1} / {totalPages}</span>
              <button
                type="button"
                onClick={() => setPage(p => (p + 1 < totalPages ? p + 1 : p))}
                disabled={page + 1 >= totalPages}
                className="px-2 py-1 rounded text-[9px] font-black uppercase tracking-wider bg-slate-100 text-slate-600 disabled:text-slate-300 disabled:cursor-not-allowed hover:bg-slate-200"
              >
                Next
              </button>
            </div>
          </div>
        </aside>

        {/* Right pane: mappings */}
        <main className="flex-1 overflow-hidden flex flex-col">
          {!selectedItem ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3">
              <svg className="w-12 h-12 text-slate-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <p className="text-[11px] font-bold uppercase tracking-widest">Select a product to view mappings</p>
            </div>
          ) : (
            <>
              <div className="bg-white border-b border-slate-200 px-5 py-3 shrink-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-black text-slate-900 tracking-tight">{selectedItem.itemId}</h2>
                  {selectedItem.classification && (
                    <span className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest bg-indigo-50 text-indigo-600 border border-indigo-100">{selectedItem.classification}</span>
                  )}
                  {approvalState && (
                    <span
                      title={approvalState.itemApproved ? formatApprovalTitle(approvalState.approvedByUsername, approvalState.approvedAt) : undefined}
                      className={`px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest border ${
                        approvalState.itemApproved
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : 'bg-slate-100 text-slate-500 border-slate-200'
                      }`}
                    >
                      {approvalState.itemApproved ? 'Item Approved' : 'Item Pending'}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 font-medium mt-0.5">{selectedItem.description}</p>

                <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                  <MultiSelectFilter
                    label="Legacy Attribute"
                    options={mappingFilterOptions.legacyAttributes}
                    selected={filterLegacyAttributes}
                    onChange={setFilterLegacyAttributes}
                  />
                  <MultiSelectFilter
                    label="Attribute Type"
                    options={mappingFilterOptions.attributeTypes}
                    selected={filterAttributeTypes}
                    onChange={setFilterAttributeTypes}
                  />
                  <MultiSelectFilter
                    label="Feasibility"
                    options={mappingFilterOptions.feasibilities}
                    selected={filterFeasibilities}
                    onChange={setFilterFeasibilities}
                  />
                  <MultiSelectFilter
                    label="Value Status"
                    options={mappingFilterOptions.valueStatuses}
                    selected={filterValueStatuses}
                    onChange={setFilterValueStatuses}
                  />
                  {hasMappingFilters && (
                    <button
                      type="button"
                      onClick={clearMappingFilters}
                      className="px-2 py-1 rounded-md text-[9px] font-black uppercase tracking-wider bg-slate-100 text-slate-500 hover:bg-slate-200 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                  <span className="ml-auto text-[9px] font-black text-slate-400 uppercase tracking-widest">
                    {filteredMappingRows.length} of {mappingRows.length} row{mappingRows.length === 1 ? '' : 's'}
                  </span>
                </div>
              </div>

              <div className="flex-1 min-h-0 flex flex-col">
                {isLoadingMappings ? (
                  <div className="flex items-center justify-center py-16">
                    <div className="w-6 h-6 border-2 border-sky-600 border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : featureGroups.length === 0 ? (
                  <div className="text-center py-16 text-[11px] text-slate-400 font-medium">
                    {hasMappingFilters ? 'No mappings match the selected filters.' : 'No mappings found for this product.'}
                  </div>
                ) : (
                  <>
                    {/* Sticky column headers */}
                    <div className="px-4 pt-4 shrink-0">
                      <div className="grid grid-cols-6 text-left text-[8px] font-black uppercase tracking-widest text-slate-400 pb-1.5 border-b border-slate-100">
                        <div className="px-4">Source Value</div>
                        <div className="px-3">Target Attribute</div>
                        <div className="px-3">Target Value</div>
                        <div className="px-3">Condition</div>
                        <div className="px-3">Feasibility</div>
                        <div className="px-3">Status</div>
                      </div>
                    </div>
                    <div className="flex-1 min-h-0 pb-4">
                      <List<MappingRowProps>
                        rowComponent={MappingListRow}
                        rowCount={flatMappingItems.length}
                        rowHeight={rowHeightCache}
                        rowProps={{
                          items: flatMappingItems,
                          translateConditions,
                          conditionSegmentsByRow,
                          approvalState,
                        }}
                        overscanCount={8}
                        style={{ height: '100%' }}
                      />
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
};

export default ProductViewer;
