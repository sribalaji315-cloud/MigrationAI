import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  User,
  WhereUsedCounterpart,
  WhereUsedItem,
  WhereUsedLegacyFeatureRow,
  WhereUsedLegacyValueRow,
  WhereUsedOption,
  WhereUsedOptionScope,
  WhereUsedSide,
  WhereUsedTargetAttributeRow,
  WhereUsedTargetValueRow,
} from '../types';
import { dbService } from '../services/dbService';

interface WhereUsedProps {
  currentUser: User;
  onClose: () => void;
}

const PAGE_SIZE = 50;
const ITEMS_PAGE_SIZE = 50;
const MIN_LEFT_W = 420;
const MIN_RIGHT_W = 300;
const BLANK_KEY = '__blank__';

type TabId = 'targetAttributes' | 'targetValues' | 'legacyFeatures' | 'legacyValues';
type AnyRow = WhereUsedTargetAttributeRow | WhereUsedTargetValueRow | WhereUsedLegacyFeatureRow | WhereUsedLegacyValueRow;

const TABS: { id: TabId; label: string; side: WhereUsedSide; scope: WhereUsedOptionScope; entity: string }[] = [
  { id: 'targetAttributes', label: 'Target Attributes', side: 'target', scope: 'targetAttributes', entity: 'Target Attribute' },
  { id: 'targetValues', label: 'Target Values', side: 'target', scope: 'targetValues', entity: 'Target Value' },
  { id: 'legacyFeatures', label: 'Legacy Features', side: 'legacy', scope: 'legacyFeatures', entity: 'Legacy Feature' },
  { id: 'legacyValues', label: 'Legacy Values', side: 'legacy', scope: 'legacyValues', entity: 'Legacy Value' },
];

interface Selection {
  side: WhereUsedSide;
  key: string;
  value?: string;
  label: string;
}

/* ---------- Multi-select searchable dropdown ---------- */
const MultiSelectDropdown: React.FC<{
  label: string;
  options: string[];
  selected: string[];
  onChange: (vals: string[]) => void;
}> = ({ label, options, selected, onChange }) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const displayText = selected.length === 0 ? label : selected.length === 1 ? selected[0] : `${selected.length} selected`;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 px-2 py-1.5 border border-slate-200 rounded-md text-xs bg-white hover:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 min-w-[120px] max-w-[180px]"
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
        <div className="absolute top-full left-0 mt-1 w-52 bg-white border border-slate-200 rounded-md shadow-lg z-30 max-h-64 overflow-auto">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-400">No options</div>
          ) : options.map(o => (
            <label key={o} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={selected.includes(o)}
                onChange={() => onChange(selected.includes(o) ? selected.filter(v => v !== o) : [...selected, o])}
                className="rounded border-slate-300 text-blue-600 focus:ring-blue-400"
              />
              <span className="truncate">{o}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
};

/* ---------- Server-backed searchable multi-select over a catalogue ---------- */
const EntityMultiSelect: React.FC<{
  label: string;
  scope: WhereUsedOptionScope;
  parent?: string;
  selected: string[];
  onChange: (vals: string[]) => void;
}> = ({ label, scope, parent, selected, onChange }) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<WhereUsedOption[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Reopening after a scope change must not show the previous tab's catalogue.
  useEffect(() => { setSearch(''); setOptions([]); }, [scope, parent]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setIsLoading(true);
    const t = setTimeout(() => {
      dbService.fetchWhereUsedOptions({ scope, parent, search: search.trim() || undefined, limit: 50 })
        .then(res => { if (!cancelled) { setOptions(res.items); setTotal(res.total); } })
        .catch(() => { if (!cancelled) { setOptions([]); setTotal(0); } })
        .finally(() => { if (!cancelled) setIsLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, scope, parent, search]);

  const toggle = (val: string) => {
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);
  };

  const displayText = selected.length === 0 ? label : selected.length === 1 ? selected[0] : `${selected.length} selected`;
  const unselectedOptions = options.filter(o => !selected.includes(o.value));

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => { setOpen(o => !o); setTimeout(() => inputRef.current?.focus(), 40); }}
        className={`flex items-center gap-1 px-2 py-1.5 border rounded-md text-xs bg-white hover:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 min-w-[200px] max-w-[280px] ${selected.length ? 'border-blue-400 text-blue-700 font-semibold' : 'border-slate-200'}`}
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
        <div className="absolute top-full left-0 mt-1 w-80 bg-white border border-slate-200 rounded-md shadow-lg z-30 max-h-80 flex flex-col">
          <div className="p-1.5 border-b border-slate-100">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="w-full px-2 py-1 border border-slate-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>
          <div className="flex-1 overflow-auto">
            {selected.map(val => (
              <label key={`sel-${val}`} className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 cursor-pointer text-xs border-b border-blue-100">
                <input type="checkbox" checked onChange={() => toggle(val)} className="rounded border-slate-300 text-blue-600 focus:ring-blue-400" />
                <span className="truncate font-semibold text-blue-700">{val}</span>
              </label>
            ))}
            {isLoading ? (
              <div className="px-3 py-2 text-xs text-slate-400 flex items-center gap-1">
                <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                Loading…
              </div>
            ) : unselectedOptions.length === 0 ? (
              <div className="px-3 py-2 text-xs text-slate-400">{selected.length ? 'No further matches' : 'No matches'}</div>
            ) : unselectedOptions.map(o => (
              <label key={o.value} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer text-xs">
                <input type="checkbox" checked={false} onChange={() => toggle(o.value)} className="rounded border-slate-300 text-blue-600 focus:ring-blue-400" />
                <span className="truncate flex-1">{o.value}</span>
                {o.description && <span className="text-[9px] text-slate-400 truncate max-w-[110px]">{o.description}</span>}
              </label>
            ))}
          </div>
          <div className="px-2 py-1 border-t border-slate-100 flex items-center justify-between">
            <span className="text-[9px] text-slate-400">
              {total > options.length ? `Showing ${options.length} of ${total.toLocaleString()} — refine search` : `${total.toLocaleString()} option${total === 1 ? '' : 's'}`}
            </span>
            {selected.length > 0 && (
              <button onClick={() => onChange([])} className="text-[9px] text-blue-600 hover:text-blue-800 font-bold uppercase tracking-wider">Clear</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/* ---------- Count badge ---------- */
const CountBadge: React.FC<{ value: number; tone?: 'blue' | 'violet' | 'emerald'; onClick?: () => void; title?: string }> = ({ value, tone = 'blue', onClick, title }) => {
  if (!value) return <span className="text-slate-300 text-[10px]">0</span>;
  const tones = {
    blue: 'bg-blue-100 text-blue-700 hover:bg-blue-200',
    violet: 'bg-violet-100 text-violet-700 hover:bg-violet-200',
    emerald: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200',
  };
  return (
    <span
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      title={title}
      className={`inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-[9px] font-bold ${tones[tone]} ${onClick ? 'cursor-pointer underline decoration-dotted' : ''}`}
    >
      {value.toLocaleString()}
    </span>
  );
};

const idClass = (isSentinel?: boolean) =>
  isSentinel ? 'italic text-slate-400 font-medium' : 'font-semibold text-slate-700';

interface Column<T> {
  key: string;
  label: string;
  sortKey?: string;
  align?: 'left' | 'center';
  render: (row: T) => React.ReactNode;
}

const WhereUsed: React.FC<WhereUsedProps> = ({ currentUser, onClose }) => {
  void currentUser;

  const [tab, setTab] = useState<TabId>('targetAttributes');
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [attributeTypes, setAttributeTypes] = useState<string[]>([]);
  const [attributeTypeOptions, setAttributeTypeOptions] = useState<string[]>([]);
  const [usageFilter, setUsageFilter] = useState<'all' | 'used' | 'unused'>('all');
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);

  // Parent key scoping the value tabs (set when drilling down from a parent tab).
  const [parentKey, setParentKey] = useState<string>('');

  const [rows, setRows] = useState<AnyRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const [selection, setSelection] = useState<Selection | null>(null);
  const [rightTab, setRightTab] = useState<'items' | 'counterparts'>('items');
  const [items, setItems] = useState<WhereUsedItem[]>([]);
  const [itemsOffset, setItemsOffset] = useState(0);
  const [itemsHasMore, setItemsHasMore] = useState(false);
  const [isLoadingItems, setIsLoadingItems] = useState(false);
  const [counterparts, setCounterparts] = useState<WhereUsedCounterpart[]>([]);
  const [counterpartSide, setCounterpartSide] = useState<WhereUsedSide>('legacy');
  const [isLoadingCounterparts, setIsLoadingCounterparts] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const [rightPanelWidth, setRightPanelWidth] = useState(400);
  const draggingRef = useRef(false);
  const requestGenRef = useRef(0);

  const attributeTypeParam = attributeTypes.length ? attributeTypes.join(',') : undefined;
  const activeTab = TABS.find(t => t.id === tab)!;

  /* --- Filter options --- */
  useEffect(() => {
    dbService.fetchWhereUsedFilters()
      .then(f => setAttributeTypeOptions(f.attributeTypes || []))
      .catch(() => { /* filters are optional */ });
  }, []);

  /* --- Resizable panel --- */
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startW = rightPanelWidth;
    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const containerW = containerRef.current.getBoundingClientRect().width;
      setRightPanelWidth(Math.max(MIN_RIGHT_W, Math.min(containerW - MIN_LEFT_W, startW + (startX - ev.clientX))));
    };
    const onMouseUp = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [rightPanelWidth]);

  /* --- Fetch the active tab --- */
  useEffect(() => {
    const gen = ++requestGenRef.current;
    setIsLoading(true);
    setError('');
    const query = {
      keys: selectedKeys.length ? selectedKeys.join(',') : undefined,
      attributeType: attributeTypeParam,
      minCount: usageFilter === 'used' ? 1 : undefined,
      maxCount: usageFilter === 'unused' ? 0 : undefined,
      sortBy: sortBy || undefined,
      sortDir,
      limit: PAGE_SIZE,
      offset,
    };

    const run = async () => {
      switch (tab) {
        case 'targetAttributes': return dbService.fetchWhereUsedTargetAttributes(query);
        case 'targetValues': return dbService.fetchWhereUsedTargetValues(parentKey || undefined, query);
        case 'legacyFeatures': return dbService.fetchWhereUsedLegacyFeatures(query);
        case 'legacyValues': return dbService.fetchWhereUsedLegacyValues(parentKey || undefined, query);
      }
    };

    run()
      .then(page => {
        if (gen !== requestGenRef.current) return;
        setRows(page.items as AnyRow[]);
        setHasMore(page.hasMore);
      })
      .catch(err => {
        if (gen !== requestGenRef.current) return;
        setRows([]);
        setHasMore(false);
        setError(err?.message || 'Failed to load usage data.');
      })
      .finally(() => { if (gen === requestGenRef.current) setIsLoading(false); });
  }, [tab, selectedKeys, attributeTypeParam, usageFilter, sortBy, sortDir, offset, parentKey]);
  /* --- Fetch side panel items --- */
  useEffect(() => {
    if (!selection) { setItems([]); setItemsHasMore(false); return; }
    let cancelled = false;
    setIsLoadingItems(true);
    dbService.fetchWhereUsedItems({
      side: selection.side,
      key: selection.key,
      value: selection.value,
      attributeType: attributeTypeParam,
      limit: ITEMS_PAGE_SIZE,
      offset: itemsOffset,
    })
      .then(page => { if (!cancelled) { setItems(page.items); setItemsHasMore(page.hasMore); } })
      .catch(() => { if (!cancelled) { setItems([]); setItemsHasMore(false); } })
      .finally(() => { if (!cancelled) setIsLoadingItems(false); });
    return () => { cancelled = true; };
  }, [selection, itemsOffset, attributeTypeParam]);

  /* --- Fetch counterparts lazily --- */
  useEffect(() => {
    if (!selection || rightTab !== 'counterparts') return;
    let cancelled = false;
    setIsLoadingCounterparts(true);
    dbService.fetchWhereUsedCounterparts({
      side: selection.side,
      key: selection.key,
      value: selection.value,
      attributeType: attributeTypeParam,
    })
      .then(res => { if (!cancelled) { setCounterparts(res.items); setCounterpartSide(res.side); } })
      .catch(() => { if (!cancelled) setCounterparts([]); })
      .finally(() => { if (!cancelled) setIsLoadingCounterparts(false); });
    return () => { cancelled = true; };
  }, [selection, rightTab, attributeTypeParam]);

  const switchTab = useCallback((next: TabId, nextParentKey = '') => {
    setTab(next);
    setParentKey(nextParentKey);
    setSelectedKeys([]);
    setOffset(0);
    setSortBy(null);
    setSortDir('desc');
    setSelection(null);
    setRightTab('items');
  }, []);

  const handleSort = useCallback((col: string) => {
    setSortBy(prev => {
      if (prev === col) {
        setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDir('desc');
      return col;
    });
    setOffset(0);
  }, []);

  const select = useCallback((next: Selection) => {
    setSelection(next);
    setItemsOffset(0);
    setRightTab('items');
  }, []);

  const SortIcon = ({ col }: { col: string }) => {
    if (sortBy !== col) return <span className="ml-0.5 text-slate-300">⇅</span>;
    return <span className="ml-0.5 text-blue-500">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  /* --- Column definitions --- */
  const columns = useMemo((): Column<any>[] => {
    switch (tab) {
      case 'targetAttributes':
        return [
          { key: 'attributeId', label: 'Target Attribute', sortKey: 'attributeId', render: (r: WhereUsedTargetAttributeRow) => (
            <span className={idClass(r.isSentinel)}>{r.attributeId}</span>
          ) },
          { key: 'description', label: 'Description', render: (r: WhereUsedTargetAttributeRow) => (
            <span className="text-slate-500 truncate max-w-[180px] block">{r.description || '—'}</span>
          ) },
          { key: 'itemCount', label: 'Items', sortKey: 'itemCount', align: 'center', render: (r: WhereUsedTargetAttributeRow) => <CountBadge value={r.itemCount} title={`Used by ${r.itemCount} BOM items`} /> },
          { key: 'legacyFeatureCount', label: 'Legacy Feats', sortKey: 'legacyFeatureCount', align: 'center', render: (r: WhereUsedTargetAttributeRow) => <CountBadge value={r.legacyFeatureCount} tone="violet" title="Distinct legacy features mapping into this attribute" /> },
          { key: 'valueCount', label: 'Values', sortKey: 'valueCount', align: 'center', render: (r: WhereUsedTargetAttributeRow) => (
            <CountBadge value={r.valueCount} tone="emerald" onClick={() => switchTab('targetValues', r.key)} title="Show target values for this attribute" />
          ) },
          { key: 'source', label: 'Declared', align: 'center', render: (r: WhereUsedTargetAttributeRow) => (
            r.inClassifications
              ? <span className="text-[8px] font-bold uppercase text-emerald-600">class</span>
              : <span className="text-[8px] font-bold uppercase text-amber-500" title="Mapped to but not declared in any classification">ad hoc</span>
          ) },
        ];
      case 'targetValues':
        return [
          { key: 'attributeId', label: 'Target Attribute', sortKey: 'attributeId', render: (r: WhereUsedTargetValueRow) => (
            <span className="font-medium text-blue-700">{r.attributeId}</span>
          ) },
          { key: 'value', label: 'Target Value', sortKey: 'value', render: (r: WhereUsedTargetValueRow) => (
            <span className={idClass(r.isSentinel)}>{r.value}</span>
          ) },
          { key: 'itemCount', label: 'Items', sortKey: 'itemCount', align: 'center', render: (r: WhereUsedTargetValueRow) => <CountBadge value={r.itemCount} /> },
          { key: 'legacyFeatureCount', label: 'Legacy Feats', sortKey: 'legacyFeatureCount', align: 'center', render: (r: WhereUsedTargetValueRow) => <CountBadge value={r.legacyFeatureCount} tone="violet" /> },
          { key: 'legacyValueCount', label: 'Legacy Vals', sortKey: 'legacyValueCount', align: 'center', render: (r: WhereUsedTargetValueRow) => <CountBadge value={r.legacyValueCount} tone="emerald" title="Distinct legacy values mapping into this target value" /> },
          { key: 'source', label: 'Declared', align: 'center', render: (r: WhereUsedTargetValueRow) => (
            r.inClassifications ? <span className="text-[8px] font-bold uppercase text-emerald-600">class</span> : <span className="text-slate-300 text-[8px]">—</span>
          ) },
        ];
      case 'legacyFeatures':
        return [
          { key: 'featureId', label: 'Legacy Feature', sortKey: 'featureId', render: (r: WhereUsedLegacyFeatureRow) => (
            <span className="font-semibold text-slate-700">{r.featureId}</span>
          ) },
          { key: 'description', label: 'Description', render: (r: WhereUsedLegacyFeatureRow) => (
            <span className="text-slate-500 truncate max-w-[180px] block">{r.description || '—'}</span>
          ) },
          { key: 'itemCount', label: 'Items', sortKey: 'itemCount', align: 'center', render: (r: WhereUsedLegacyFeatureRow) => <CountBadge value={r.itemCount} /> },
          { key: 'targetAttributeCount', label: 'Target Attrs', sortKey: 'targetAttributeCount', align: 'center', render: (r: WhereUsedLegacyFeatureRow) => <CountBadge value={r.targetAttributeCount} tone="violet" title="Distinct target attributes this feature maps to" /> },
          { key: 'legacyValueCount', label: 'Options', sortKey: 'legacyValueCount', align: 'center', render: (r: WhereUsedLegacyFeatureRow) => (
            <CountBadge value={r.legacyValueCount} tone="emerald" onClick={() => switchTab('legacyValues', r.key)} title="Show legacy values for this feature" />
          ) },
        ];
      case 'legacyValues':
        return [
          { key: 'featureId', label: 'Legacy Feature', sortKey: 'featureId', render: (r: WhereUsedLegacyValueRow) => (
            <span className="font-medium text-blue-700">{r.featureId}</span>
          ) },
          { key: 'value', label: 'Option', sortKey: 'value', render: (r: WhereUsedLegacyValueRow) => (
            <span className="font-semibold text-slate-700">{r.value}</span>
          ) },
          { key: 'itemCount', label: 'Items', sortKey: 'itemCount', align: 'center', render: (r: WhereUsedLegacyValueRow) => <CountBadge value={r.itemCount} /> },
          { key: 'targetAttributeCount', label: 'Target Attrs', sortKey: 'targetAttributeCount', align: 'center', render: (r: WhereUsedLegacyValueRow) => <CountBadge value={r.targetAttributeCount} tone="violet" /> },
          { key: 'targetValueCount', label: 'Target Vals', sortKey: 'targetValueCount', align: 'center', render: (r: WhereUsedLegacyValueRow) => <CountBadge value={r.targetValueCount} tone="emerald" /> },
          { key: 'source', label: 'In BOM', align: 'center', render: (r: WhereUsedLegacyValueRow) => (
            r.inBom && r.itemCount === 0
              ? <span className="text-[8px] font-bold uppercase text-amber-500" title="Present on BOM items but never mapped">unmapped</span>
              : <span className="text-slate-300 text-[8px]">—</span>
          ) },
        ];
    }
  }, [tab, switchTab]);

  const rowIdentity = useCallback((row: AnyRow): Selection => {
    switch (tab) {
      case 'targetAttributes': {
        const r = row as WhereUsedTargetAttributeRow;
        return { side: 'target', key: r.key, label: r.attributeId };
      }
      case 'targetValues': {
        const r = row as WhereUsedTargetValueRow;
        return { side: 'target', key: r.attributeKey, value: r.valueKey, label: `${r.attributeId} → ${r.value}` };
      }
      case 'legacyFeatures': {
        const r = row as WhereUsedLegacyFeatureRow;
        return { side: 'legacy', key: r.key, label: r.featureId };
      }
      case 'legacyValues': {
        const r = row as WhereUsedLegacyValueRow;
        return { side: 'legacy', key: r.featureKey, value: r.valueKey, label: `${r.featureId} → ${r.value}` };
      }
    }
  }, [tab]);

  const isSelected = useCallback((row: AnyRow) => {
    if (!selection) return false;
    const id = rowIdentity(row);
    return id.key === selection.key && id.value === selection.value;
  }, [selection, rowIdentity]);

  const parentLabel = parentKey === BLANK_KEY ? '(blank)' : parentKey;
  const counterpartTitle = counterpartSide === 'legacy' ? 'Mapped from (legacy)' : 'Mapped to (target)';

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      {/* Header */}
      <div className="shrink-0 bg-white border-b border-slate-200 px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-black text-slate-800 uppercase tracking-wider">Where Used</h1>
          <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">
            Usage from workspace mappings
          </span>
        </div>
        <button
          onClick={onClose}
          className="px-3 py-1.5 bg-slate-100 text-slate-600 rounded-md text-[9px] font-black uppercase tracking-wider hover:bg-slate-200"
        >
          Close
        </button>
      </div>

      {/* Tabs */}
      <div className="shrink-0 bg-white border-b border-slate-200 px-5 flex items-center gap-0">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => switchTab(t.id)}
            className={`px-4 py-2 text-[9px] font-black uppercase tracking-wider border-b-2 transition-colors ${
              tab === t.id ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="shrink-0 bg-slate-50 border-b border-slate-200 px-5 py-2 flex items-center gap-3 flex-wrap">
        <EntityMultiSelect
          label={activeTab.entity}
          scope={activeTab.scope}
          parent={parentKey || undefined}
          selected={selectedKeys}
          onChange={v => { setSelectedKeys(v); setOffset(0); }}
        />
        <MultiSelectDropdown
          label="Attribute Type"
          options={attributeTypeOptions}
          selected={attributeTypes}
          onChange={v => { setAttributeTypes(v); setOffset(0); }}
        />
        <div className="flex rounded-md border border-slate-200 overflow-hidden">
          {(['all', 'used', 'unused'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => { setUsageFilter(mode); setOffset(0); }}
              className={`px-2.5 py-1.5 text-[9px] font-black uppercase tracking-wider transition-colors ${
                usageFilter === mode ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-100'
              }`}
            >
              {mode === 'all' ? 'All' : mode === 'used' ? 'Used' : 'Unused'}
            </button>
          ))}
        </div>
        {parentKey && (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-blue-50 border border-blue-100 rounded-md text-[9px] font-bold text-blue-700 uppercase tracking-wider">
            {parentLabel}
            <button onClick={() => { setParentKey(''); setOffset(0); }} className="text-blue-400 hover:text-red-500">×</button>
          </span>
        )}
        {attributeTypes.length > 0 && (
          <span className="text-[9px] font-bold text-amber-600 uppercase tracking-wider" title="Unused rows have no attribute type, so they are hidden while this filter is active">
            Unused rows hidden
          </span>
        )}
      </div>

      {/* Main content */}
      <div ref={containerRef} className="flex flex-1 overflow-hidden">
        {/* Left: table */}
        <div className="flex flex-col overflow-hidden" style={{ width: `calc(100% - ${rightPanelWidth}px)`, minWidth: MIN_LEFT_W }}>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr>
                  {columns.map(c => (
                    <th
                      key={c.key}
                      onClick={c.sortKey ? () => handleSort(c.sortKey!) : undefined}
                      className={`${c.align === 'center' ? 'text-center' : 'text-left'} px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200${c.sortKey ? ' cursor-pointer select-none' : ''}`}
                    >
                      {c.label}{c.sortKey && <SortIcon col={c.sortKey} />}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={columns.length} className="text-center py-10">
                      <div className="flex items-center justify-center gap-2 text-slate-400">
                        <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        Aggregating usage…
                      </div>
                    </td>
                  </tr>
                ) : error ? (
                  <tr><td colSpan={columns.length} className="text-center py-10 text-rose-500 text-xs">{error}</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={columns.length} className="text-center py-10 text-slate-400 text-xs">No matches found.</td></tr>
                ) : rows.map((row, i) => (
                  <tr
                    key={`${tab}-${i}`}
                    onClick={() => select(rowIdentity(row))}
                    className={`cursor-pointer border-b border-slate-100 transition-colors ${isSelected(row) ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-slate-50'}`}
                  >
                    {columns.map(c => (
                      <td key={c.key} className={`px-3 py-1.5${c.align === 'center' ? ' text-center' : ''}`}>{c.render(row)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Paging */}
          <div className="flex items-center justify-between px-3 py-2 bg-white border-t border-slate-200 shrink-0">
            <button
              onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))}
              disabled={offset === 0 || isLoading}
              className="px-2 py-1 text-[9px] font-bold text-slate-500 bg-slate-100 rounded hover:bg-slate-200 disabled:opacity-40"
            >
              ← Prev
            </button>
            <span className="text-[9px] text-slate-400 font-medium">
              {rows.length === 0 ? '—' : `${(offset + 1).toLocaleString()}–${(offset + rows.length).toLocaleString()}`}
            </span>
            <button
              onClick={() => setOffset(o => o + PAGE_SIZE)}
              disabled={!hasMore || isLoading}
              className="px-2 py-1 text-[9px] font-bold text-slate-500 bg-slate-100 rounded hover:bg-slate-200 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>

        {/* Drag handle */}
        <div
          onMouseDown={handleMouseDown}
          className="w-1.5 cursor-col-resize bg-slate-200 hover:bg-blue-400 active:bg-blue-500 transition-colors shrink-0"
        />

        {/* Right panel */}
        <div style={{ width: rightPanelWidth, minWidth: MIN_RIGHT_W }} className="flex flex-col overflow-hidden bg-white shrink-0">
          <div className="border-b border-slate-200 bg-slate-50 shrink-0 px-4 pt-2.5">
            <h2 className="text-[9px] font-black uppercase tracking-wider text-slate-500 mb-2 truncate" title={selection?.label}>
              {selection ? selection.label : 'Select a row'}
            </h2>
            {selection && (
              <div className="flex gap-0">
                <button
                  onClick={() => setRightTab('items')}
                  className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-wider border-b-2 transition-colors ${rightTab === 'items' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
                >
                  Items
                </button>
                <button
                  onClick={() => setRightTab('counterparts')}
                  className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-wider border-b-2 transition-colors ${rightTab === 'counterparts' ? 'border-violet-500 text-violet-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
                >
                  {counterpartTitle}
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-auto">
            {!selection ? (
              <div className="flex items-center justify-center h-full text-slate-300 text-xs text-center px-6">
                Click a row to see the BOM items it is used by, and what it maps to.
              </div>
            ) : rightTab === 'items' ? (
              isLoadingItems ? (
                <div className="flex items-center justify-center h-32">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : items.length === 0 ? (
                <div className="text-center py-8 text-slate-400 text-xs">No BOM items use this.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Item</th>
                      <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Description</th>
                      <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Category</th>
                      <th className="text-center px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Pri</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(item => (
                      <tr key={item.itemId} className="border-b border-slate-50 hover:bg-slate-50">
                        <td className="px-3 py-1.5 font-semibold text-slate-700">{item.itemId}</td>
                        <td className="px-3 py-1.5 text-slate-500 truncate max-w-[160px]" title={item.description}>{item.description || '—'}</td>
                        <td className="px-3 py-1.5 text-slate-400">{item.category || '—'}</td>
                        <td className="px-3 py-1.5 text-center">
                          {item.priority != null
                            ? <span className="inline-block px-1.5 py-0.5 bg-amber-50 text-amber-600 rounded text-[10px] font-bold">P{item.priority}</span>
                            : <span className="text-[10px] text-slate-300">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : isLoadingCounterparts ? (
              <div className="flex items-center justify-center h-32">
                <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : counterparts.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-xs">Nothing on the other side.</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-slate-50 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">
                      {counterpartSide === 'legacy' ? 'Feature' : 'Attribute'}
                    </th>
                    <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Value</th>
                    <th className="text-center px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Items</th>
                  </tr>
                </thead>
                <tbody>
                  {counterparts.map((c, i) => (
                    <tr key={`${c.key}-${c.value}-${i}`} className="border-b border-slate-50 hover:bg-slate-50">
                      <td className="px-3 py-1.5 font-medium text-blue-700">{c.key}</td>
                      <td className="px-3 py-1.5 text-slate-600">{c.value}</td>
                      <td className="px-3 py-1.5 text-center"><CountBadge value={c.itemCount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Items paging */}
          {selection && rightTab === 'items' && (itemsOffset > 0 || itemsHasMore) && (
            <div className="flex items-center justify-between px-3 py-2 bg-white border-t border-slate-200 shrink-0">
              <button
                onClick={() => setItemsOffset(o => Math.max(0, o - ITEMS_PAGE_SIZE))}
                disabled={itemsOffset === 0 || isLoadingItems}
                className="px-2 py-1 text-[9px] font-bold text-slate-500 bg-slate-100 rounded hover:bg-slate-200 disabled:opacity-40"
              >
                ← Prev
              </button>
              <span className="text-[9px] text-slate-400 font-medium">
                {items.length === 0 ? '—' : `${(itemsOffset + 1).toLocaleString()}–${(itemsOffset + items.length).toLocaleString()}`}
              </span>
              <button
                onClick={() => setItemsOffset(o => o + ITEMS_PAGE_SIZE)}
                disabled={!itemsHasMore || isLoadingItems}
                className="px-2 py-1 text-[9px] font-bold text-slate-500 bg-slate-100 rounded hover:bg-slate-200 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default WhereUsed;
