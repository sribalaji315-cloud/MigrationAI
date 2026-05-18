import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { User, GroupFeatureRow, GroupFeatureMappingJobProgress, GroupFeatureWhereUsedItem, GroupFeatureFilters } from '../types';
import { dbService } from '../services/dbService';

interface GroupFeaturesProps {
  currentUser: User;
  onClose: () => void;
}

const PAGE_SIZE = 50;
const MIN_LEFT_W = 400;
const MIN_RIGHT_W = 280;

/* ---------- CSV column name → backend key mapping ---------- */
const HEADER_MAP: Record<string, string> = {
  'FeatureGroup': 'featureGroup',
  'Feature': 'featureId',
  'Feature Desc': 'featureDesc',
  'Option': 'option',
  'Option Desc': 'optionDesc',
  'Condition': 'condition',
  'Till': 'tillDate',
  'From': 'fromDate',
  'Seq.': 'seq',
  'Group': 'group',
  'Prouct Group(s)': 'productGroups',
  'Product Group(s)': 'productGroups',
};

/** Parse CSV handling quoted fields with embedded commas/newlines */
function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
      if (ch === '\r') i++;
      row.push(cell.trim());
      cell = '';
      if (row.some(c => c !== '')) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  // last cell / row
  row.push(cell.trim());
  if (row.some(c => c !== '')) rows.push(row);

  if (rows.length < 2) return [];

  const headers = rows[0].map(h => HEADER_MAP[h] || h);
  const result: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = rows[i][idx] || ''; });
    result.push(obj);
  }
  return result;
}

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

  const displayText = selected.length === 0 ? label : selected.length === 1 ? (selected[0] === '__blank__' ? '(Blanks)' : selected[0]) : `${selected.length} selected`;

  const displayLabel = (o: string) => o === '__blank__' ? '(Blanks)' : o;

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
                <span className="truncate">{displayLabel(o)}</span>
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

/* ---------- Status color helper ---------- */
const statusColor = (s: string) => {
  switch (s) {
    case 'discontinued': return 'bg-red-100 text-red-700';
    case 'approved': return 'bg-emerald-100 text-emerald-700';
    case 'review': return 'bg-cyan-100 text-cyan-700';
    case 'ignored': return 'bg-slate-100 text-slate-500';
    default: return 'bg-amber-100 text-amber-700';
  }
};

const STATUS_OPTIONS = ['in_progress', 'review', 'approved', 'discontinued', 'ignored'];

/* ---------- Inline searchable dropdown ---------- */
interface InlineDropdownProps {
  value: string | null;
  onSave: (val: string | null) => void;
  fetchOptions: (search: string) => Promise<{ label: string; description?: string }[]>;
  suggestions?: { label: string; description?: string; score?: number }[];
  placeholder?: string;
  emptyColor?: string;
  autoOpen?: boolean;
}

const InlineSearchDropdown: React.FC<InlineDropdownProps> = ({ value, onSave, fetchOptions, suggestions, placeholder, emptyColor, autoOpen }) => {
  const [open, setOpen] = useState(!!autoOpen);
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<{ label: string; description?: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const loadOptions = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const opts = await fetchOptions(q);
      setOptions(opts);
    } catch { setOptions([]); }
    setLoading(false);
  }, [fetchOptions]);

  // Auto-load options when autoOpen
  useEffect(() => {
    if (autoOpen) { loadOptions(''); setTimeout(() => inputRef.current?.focus(), 50); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpen = useCallback(() => {
    setOpen(true);
    setSearch('');
    loadOptions('');
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [loadOptions]);

  const handleSearch = useCallback((val: string) => {
    setSearch(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => loadOptions(val), 200);
  }, [loadOptions]);

  const handleSelect = useCallback((val: string) => {
    onSave(val);
    setOpen(false);
  }, [onSave]);

  const handleClear = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSave(null);
    setOpen(false);
  }, [onSave]);

  // Merge suggestions at top, then fetched options (deduped)
  const mergedOptions = useMemo(() => {
    const result: { label: string; description?: string; isSuggestion?: boolean }[] = [];
    const seen = new Set<string>();
    if (suggestions && suggestions.length > 0) {
      for (const s of suggestions.slice(0, 3)) {
        result.push({ label: s.label, description: s.description || (s.score != null ? `${Math.round(s.score * 100)}% match` : ''), isSuggestion: true });
        seen.add(s.label.toUpperCase());
      }
    }
    for (const o of options) {
      if (!seen.has(o.label.toUpperCase())) {
        result.push(o);
        seen.add(o.label.toUpperCase());
      }
    }
    return result;
  }, [suggestions, options]);

  if (!open) {
    return (
      <span
        onClick={(e) => { e.stopPropagation(); handleOpen(); }}
        className={`cursor-pointer px-1 py-0.5 rounded text-xs hover:ring-1 hover:ring-blue-400 inline-block min-w-[40px] ${value ? 'font-medium text-emerald-700' : (emptyColor || 'text-red-400 bg-red-50')}`}
        title="Click to edit"
      >
        {value || placeholder || '—'}
      </span>
    );
  }

  return (
    <div ref={ref} className="relative z-40" onClick={e => e.stopPropagation()}>
      <input
        ref={inputRef}
        type="text"
        value={search}
        onChange={e => handleSearch(e.target.value)}
        placeholder="Search…"
        className="w-full px-1.5 py-0.5 border border-blue-400 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-[120px]"
      />
      <div className="absolute top-full left-0 mt-0.5 w-64 bg-white border border-slate-200 rounded-md shadow-lg max-h-48 overflow-auto">
        {loading ? (
          <div className="px-3 py-2 text-xs text-slate-400 flex items-center gap-1">
            <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            Loading…
          </div>
        ) : mergedOptions.length === 0 ? (
          <div className="px-3 py-2 text-xs text-slate-400">No matches</div>
        ) : (
          <>
            {mergedOptions.map((o, i) => (
              <div
                key={`${o.label}-${i}`}
                onClick={() => handleSelect(o.label)}
                className={`px-3 py-1.5 hover:bg-blue-50 cursor-pointer text-xs flex items-center justify-between ${o.isSuggestion ? 'bg-amber-50 border-l-2 border-amber-400' : ''} ${o.label === value ? 'bg-emerald-50 font-semibold' : ''}`}
              >
                <span className="truncate">{o.label}</span>
                {o.description && <span className="text-[9px] text-slate-400 ml-2 shrink-0">{o.description}</span>}
              </div>
            ))}
          </>
        )}
        {value && (
          <div className="border-t border-slate-100 px-3 py-1.5">
            <button onClick={handleClear} className="text-[9px] text-red-500 hover:text-red-700 font-bold uppercase">Clear</button>
          </div>
        )}
      </div>
    </div>
  );
};

/* ---------- Inline status dropdown ---------- */
interface InlineStatusDropdownProps {
  value: string;
  onSave: (val: string) => void;
}

const InlineStatusDropdown: React.FC<InlineStatusDropdownProps> = ({ value, onSave }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (!open) {
    return (
      <span
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase cursor-pointer hover:ring-1 hover:ring-blue-400 ${statusColor(value)}`}
        title="Click to change status"
      >
        {value}
      </span>
    );
  }

  return (
    <div ref={ref} className="relative z-40" onClick={e => e.stopPropagation()}>
      <div className="absolute top-0 left-0 bg-white border border-slate-200 rounded-md shadow-lg py-1 w-32">
        {STATUS_OPTIONS.map(s => (
          <div
            key={s}
            onClick={() => { onSave(s); setOpen(false); }}
            className={`px-3 py-1.5 cursor-pointer text-xs font-bold uppercase hover:bg-slate-50 ${s === value ? 'bg-blue-50' : ''}`}
          >
            <span className={`inline-block px-1.5 py-0.5 rounded ${statusColor(s)}`}>{s}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* ---------- Column definitions ---------- */
type ColAlign = 'left' | 'center';
interface ColDef {
  key: string;
  label: string;
  sortKey?: string;          // if sortable
  align?: ColAlign;
  defaultVisible?: boolean;  // default true
  render: (r: GroupFeatureRow, callbacks?: ColumnCallbacks) => React.ReactNode;
  className?: string;
}

interface ColumnCallbacks {
  onUpdateRow: (id: number, updates: { targetAttribute?: string | null; targetValue?: string | null; valueStatus?: string }) => void;
  fetchAttrOptions: (search: string) => Promise<{ label: string; description?: string }[]>;
  fetchValOptions: (attributeId: string, search: string) => Promise<{ label: string; description?: string }[]>;
  isAdmin: boolean;
}

const ALL_COLUMNS: ColDef[] = [
  { key: 'group', label: 'Group', sortKey: 'featureGroup', render: r => <span className="font-semibold text-slate-700 whitespace-nowrap">{r.featureGroup}</span> },
  { key: 'whereUsed', label: 'Where Used', sortKey: 'whereUsedCount', align: 'center', render: r =>
    r.whereUsedCount != null && r.whereUsedCount > 0
      ? <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[9px] font-bold" title={`Used in ${r.whereUsedCount} BOM items`}>{r.whereUsedCount}</span>
      : <span className="text-slate-300">0</span>
  },
  { key: 'featureId', label: 'Feature ID', sortKey: 'featureId', render: r => <span className="font-medium text-blue-700 whitespace-nowrap">{r.featureId}</span> },
  { key: 'description', label: 'Description', render: r => <span className="text-slate-500 truncate max-w-[140px] block">{r.featureDesc || '—'}</span> },
  { key: 'option', label: 'Option', sortKey: 'option', render: r => <span className="text-slate-600">{r.option || '—'}</span> },
  { key: 'optionDesc', label: 'Option Desc', render: r => <span className="text-slate-400 truncate max-w-[120px] block">{r.optionDesc || '—'}</span> },
  { key: 'condition', label: 'Condition', defaultVisible: false, render: r => <span className="text-slate-400">{r.condition || '—'}</span> },
  { key: 'tillDate', label: 'Till Date', sortKey: 'tillDate', render: r => <span className="text-slate-400 whitespace-nowrap">{r.tillDate || '—'}</span> },
  { key: 'targetAttr', label: 'Target Attr', sortKey: 'targetAttribute', render: (r, cb) => {
    if (!cb?.isAdmin) return <span className="font-medium text-emerald-700 whitespace-nowrap">{r.targetAttribute || '—'}</span>;
    const suggestions = r.suggestedAttributes?.map(s => ({ label: s.attributeId, description: s.description, score: s.score })) || [];
    // If existing mapping exists, make it the top suggestion
    if (r.targetAttribute) {
      const existing = { label: r.targetAttribute, description: 'Current mapping', score: 1 };
      const filtered = suggestions.filter(s => s.label.toUpperCase() !== r.targetAttribute!.toUpperCase());
      suggestions.length = 0;
      suggestions.push(existing, ...filtered);
    }
    return <InlineSearchDropdown
      value={r.targetAttribute}
      suggestions={suggestions.slice(0, 3)}
      fetchOptions={cb.fetchAttrOptions}
      onSave={(val) => cb.onUpdateRow(r.id, { targetAttribute: val })}
      placeholder="Set attribute"
    />;
  }},
  { key: 'targetValue', label: 'Target Value', sortKey: 'targetValue', render: (r, cb) => {
    if (!cb?.isAdmin) return <span className="text-slate-600">{r.targetValue || '—'}</span>;
    if (!r.targetAttribute) return <span className="text-slate-300 text-[9px]">Set attr first</span>;
    const suggestions = r.suggestedValues?.map(v => ({ label: v })) || [];
    if (r.targetValue) {
      const existing = { label: r.targetValue, description: 'Current value' };
      const filtered = suggestions.filter(s => s.label.toUpperCase() !== r.targetValue!.toUpperCase());
      suggestions.length = 0;
      suggestions.push(existing, ...filtered);
    }
    return <InlineSearchDropdown
      value={r.targetValue}
      suggestions={suggestions.slice(0, 3)}
      fetchOptions={(search) => cb.fetchValOptions(r.targetAttribute!, search)}
      onSave={(val) => cb.onUpdateRow(r.id, { targetValue: val })}
      placeholder="Set value"
    />;
  }},
  { key: 'status', label: 'Status', sortKey: 'valueStatus', align: 'center', render: (r, cb) => {
    if (!cb?.isAdmin) return <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${statusColor(r.valueStatus)}`}>{r.valueStatus}</span>;
    return <InlineStatusDropdown value={r.valueStatus} onSave={(val) => cb.onUpdateRow(r.id, { valueStatus: val })} />;
  }},
  { key: 'valueList', label: 'Value List', render: r => <span className="text-slate-400 whitespace-nowrap">{r.valuelistId || '—'}</span> },
  { key: 'suggestedAttrs', label: 'Suggested Attrs', defaultVisible: false, render: r => {
    const sa = r.suggestedAttributes;
    if (!sa || sa.length === 0) return <span className="text-slate-300">—</span>;
    return <span className="text-[9px] text-amber-700" title={sa.map(s => `${s.attributeId}: ${s.description} (${Math.round(s.score * 100)}%)`).join('\n')}>{sa.map(s => `${s.attributeId} (${Math.round(s.score * 100)}%)`).join(', ')}</span>;
  }},
  { key: 'suggestedVals', label: 'Suggested Vals', defaultVisible: false, render: r => {
    const sv = r.suggestedValues;
    if (!sv || sv.length === 0) return <span className="text-slate-300">—</span>;
    return <span className="text-[9px] text-amber-700" title={sv.join('\n')}>{sv.join(', ')}</span>;
  }},
];

const DEFAULT_VISIBLE = new Set(ALL_COLUMNS.filter(c => c.defaultVisible !== false).map(c => c.key));

const GroupFeatures: React.FC<GroupFeaturesProps> = ({ currentUser, onClose }) => {
  // Upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ ok: boolean; rowsInserted: number } | null>(null);

  // Mapping job state
  const [jobProgress, setJobProgress] = useState<GroupFeatureMappingJobProgress | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Suggest job state
  const [suggestProgress, setSuggestProgress] = useState<GroupFeatureMappingJobProgress | null>(null);
  const [isSuggestTriggering, setIsSuggestTriggering] = useState(false);
  const suggestPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // List state
  const [rows, setRows] = useState<GroupFeatureRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Selection state for bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showBulkAttr, setShowBulkAttr] = useState(false);
  const [showBulkStatus, setShowBulkStatus] = useState(false);
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);

  // Filter state
  const [filterGroups, setFilterGroups] = useState<string[]>([]);
  const [filterFeatureIds, setFilterFeatureIds] = useState<string[]>([]);
  const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
  const [filterTargetAttrs, setFilterTargetAttrs] = useState<string[]>([]);
  const [filterTargetVals, setFilterTargetVals] = useState<string[]>([]);
  const [filterOptions, setFilterOptions] = useState<GroupFeatureFilters>({ featureGroups: [], featureIds: [], valueStatuses: [], targetAttributes: [], targetValues: [] });

  // Column visibility
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => new Set(DEFAULT_VISIBLE));
  const [showColMenu, setShowColMenu] = useState(false);
  const colMenuRef = useRef<HTMLDivElement>(null);

  const toggleCol = useCallback((key: string) => {
    setVisibleCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  // Close column menu on outside click
  useEffect(() => {
    if (!showColMenu) return;
    const handler = (e: MouseEvent) => {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target as Node)) setShowColMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showColMenu]);

  const activeCols = useMemo(() => ALL_COLUMNS.filter(c => visibleCols.has(c.key)), [visibleCols]);

  // Where-used panel
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [whereUsedItems, setWhereUsedItems] = useState<GroupFeatureWhereUsedItem[]>([]);
  const [whereUsedTotal, setWhereUsedTotal] = useState(0);
  const [isLoadingWhereUsed, setIsLoadingWhereUsed] = useState(false);
  const [rightTab, setRightTab] = useState<'whereUsed' | 'subFeatures'>('subFeatures');
  const [subFeatures, setSubFeatures] = useState<GroupFeatureRow[]>([]);
  const [isLoadingSubFeatures, setIsLoadingSubFeatures] = useState(false);

  // Valuelist generation
  const [isGeneratingVL, setIsGeneratingVL] = useState(false);
  const [vlResult, setVlResult] = useState<{ valuelistsCreated: number; skippedFeatures: string[] } | null>(null);
  const [vlError, setVlError] = useState<string | null>(null);

  // CSV export progress
  const [isExporting, setIsExporting] = useState(false);

  // Stats
  const [stats, setStats] = useState<{ totalGroups: number; totalSubFeatures: number; totalValues: number; statusCounts: Record<string, number>; unmappedAttributes: number; totalWhereUsed: number } | null>(null);

  // Resizable panel
  const containerRef = useRef<HTMLDivElement>(null);
  const [rightPanelWidth, setRightPanelWidth] = useState(380);
  const draggingRef = useRef(false);

  // All authenticated users have full write access to Group Features.
  // The 3 header buttons (Upload CSV, Apply Mappings, AI Suggest) are gated separately below using currentUser.role.
  const isAdmin = true;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // --- Resize ---
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startW = rightPanelWidth;
    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const containerW = containerRef.current.getBoundingClientRect().width;
      const delta = startX - ev.clientX;
      setRightPanelWidth(Math.max(MIN_RIGHT_W, Math.min(containerW - MIN_LEFT_W, startW + delta)));
    };
    const onMouseUp = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [rightPanelWidth]);

  // --- Load filters (cascade: featureIds depend on selected groups) ---
  const loadFilters = useCallback(async (groups?: string[]) => {
    try {
      const grpParam = groups && groups.length ? groups.join(',') : undefined;
      const f = await dbService.fetchGroupFeatureFilters(grpParam);
      setFilterOptions(f);
      // If featureId filter has values no longer available, prune them
      if (groups && groups.length) {
        setFilterFeatureIds(prev => prev.filter(fid => f.featureIds.includes(fid)));
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadFilters(filterGroups); }, [filterGroups, loadFilters]);

  // --- Fetch stats (respects all filters) ---
  const fetchStats = useCallback(async () => {
    try {
      const s = await dbService.fetchGroupFeatureStats({
        search: search || undefined,
        featureGroup: filterGroups.length ? filterGroups.join(',') : undefined,
        featureId: filterFeatureIds.length ? filterFeatureIds.join(',') : undefined,
        valueStatus: filterStatuses.length ? filterStatuses.join(',') : undefined,
        targetAttribute: filterTargetAttrs.length ? filterTargetAttrs.join(',') : undefined,
        targetValue: filterTargetVals.length ? filterTargetVals.join(',') : undefined,
      });
      setStats(s);
    } catch { /* ignore */ }
  }, [search, filterGroups, filterFeatureIds, filterStatuses, filterTargetAttrs, filterTargetVals]);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  // --- Inline editing callbacks ---
  const handleUpdateRow = useCallback(async (id: number, updates: { targetAttribute?: string | null; targetValue?: string | null; valueStatus?: string }) => {
    try {
      const result = await dbService.updateGroupFeatureRow(id, updates);
      setRows(prev => prev.map(r => r.id === id ? {
        ...r,
        targetAttribute: result.targetAttribute,
        targetValue: result.targetValue,
        valueStatus: result.valueStatus,
      } : r));
      setSubFeatures(prev => prev.map(r => r.id === id ? {
        ...r,
        targetAttribute: result.targetAttribute,
        targetValue: result.targetValue,
        valueStatus: result.valueStatus,
      } : r));
      fetchStats();
    } catch (err: any) {
      alert(`Update failed: ${err.message}`);
    }
  }, [fetchStats]);

  const fetchAttrOptions = useCallback(async (search: string): Promise<{ label: string; description?: string }[]> => {
    const result = await dbService.fetchGroupFeatureClassificationAttributes(search || undefined, 20);
    return result.items.map(a => ({ label: a.attributeId, description: a.description || `${a.classCount} classes` }));
  }, []);

  const fetchValOptions = useCallback(async (attributeId: string, search: string): Promise<{ label: string; description?: string }[]> => {
    const result = await dbService.fetchGroupFeatureAttributeValues(attributeId, search || undefined, 20);
    return result.items.map(v => ({ label: v.value, description: v.description }));
  }, []);

  const columnCallbacks = useMemo<ColumnCallbacks>(() => ({
    onUpdateRow: handleUpdateRow,
    fetchAttrOptions,
    fetchValOptions,
    isAdmin,
  }), [handleUpdateRow, fetchAttrOptions, fetchValOptions, isAdmin]);

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === rows.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(rows.map(r => r.id)));
    }
  }, [rows, selectedIds]);

  const toggleSelectRow = useCallback((id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // --- Fetch list ---
  const handleSort = useCallback((col: string) => {
    if (sortBy === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      setSortDir('asc');
    }
    setPage(0);
  }, [sortBy]);

  const SortIcon = ({ col }: { col: string }) => {
    if (sortBy !== col) return <span className="ml-0.5 text-slate-300">⇅</span>;
    return <span className="ml-0.5 text-blue-500">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  const fetchList = useCallback(async (p: number, s: string, groups: string[], fids: string[], statuses: string[], sb: string | null, sd: string, tAttrs: string[] = [], tVals: string[] = []) => {
    setIsLoading(true);
    try {
      const result = await dbService.fetchGroupFeatures({
        search: s || undefined,
        featureGroup: groups.length ? groups.join(',') : undefined,
        featureId: fids.length ? fids.join(',') : undefined,
        valueStatus: statuses.length ? statuses.join(',') : undefined,
        targetAttribute: tAttrs.length ? tAttrs.join(',') : undefined,
        targetValue: tVals.length ? tVals.join(',') : undefined,
        sortBy: sb || undefined,
        sortDir: sb ? sd : undefined,
        limit: PAGE_SIZE,
        offset: p * PAGE_SIZE,
      });
      setRows(result.items);
      setTotal(result.total);
    } catch (err: any) {
      console.error('Failed to fetch group features', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const clearBulkSelection = useCallback(() => {
    setSelectedIds(new Set());
    setShowBulkAttr(false);
    setShowBulkStatus(false);
  }, []);

  // --- Bulk update handlers ---
  const handleBulkSetAttribute = useCallback(async (targetAttribute: string | null) => {
    if (selectedIds.size === 0) return;
    setIsBulkUpdating(true);
    try {
      const ids = Array.from(selectedIds);
      await dbService.bulkUpdateGroupFeatureTarget(ids, { targetAttribute });
      setRows(prev => prev.map(r => selectedIds.has(r.id) ? { ...r, targetAttribute } : r));
      setSubFeatures(prev => prev.map(r => selectedIds.has(r.id) ? { ...r, targetAttribute } : r));
      clearBulkSelection();
      fetchStats();
    } catch (err: any) {
      alert(`Bulk update failed: ${err.message}`);
    } finally {
      setIsBulkUpdating(false);
    }
  }, [selectedIds, clearBulkSelection, fetchStats]);

  const handleBulkSetStatus = useCallback(async (valueStatus: string) => {
    if (selectedIds.size === 0) return;
    setIsBulkUpdating(true);
    try {
      const ids = Array.from(selectedIds);
      await dbService.updateGroupFeatureStatus(ids, valueStatus);
      setRows(prev => prev.map(r => selectedIds.has(r.id) ? { ...r, valueStatus } : r));
      setSubFeatures(prev => prev.map(r => selectedIds.has(r.id) ? { ...r, valueStatus } : r));
      clearBulkSelection();
      fetchStats();
      await fetchList(page, search, filterGroups, filterFeatureIds, filterStatuses, sortBy, sortDir, filterTargetAttrs, filterTargetVals);
    } catch (err: any) {
      alert(`Bulk status update failed: ${err.message}`);
    } finally {
      setIsBulkUpdating(false);
    }
  }, [selectedIds, clearBulkSelection, fetchStats, fetchList, page, search, filterGroups, filterFeatureIds, filterStatuses, sortBy, sortDir, filterTargetAttrs, filterTargetVals]);

  useEffect(() => {
    fetchList(page, search, filterGroups, filterFeatureIds, filterStatuses, sortBy, sortDir, filterTargetAttrs, filterTargetVals);
  }, [page, search, filterGroups, filterFeatureIds, filterStatuses, sortBy, sortDir, filterTargetAttrs, filterTargetVals, fetchList]);

  // --- Job polling ---
  const pollProgress = useCallback(async () => {
    try {
      const p = await dbService.fetchGroupFeatureMappingProgress();
      setJobProgress(p);
      const isActive = p.status === 'queued' || p.status === 'running';
      pollRef.current = setTimeout(pollProgress, isActive ? 2000 : 10000);
    } catch {
      pollRef.current = setTimeout(pollProgress, 10000);
    }
  }, []);

  useEffect(() => {
    pollProgress();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [pollProgress]);

  // Auto-refresh after job completes
  const prevJobStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevJobStatus.current === 'running' && jobProgress?.status === 'completed') {
      fetchList(page, search, filterGroups, filterFeatureIds, filterStatuses, sortBy, sortDir, filterTargetAttrs, filterTargetVals);
      loadFilters();
    }
    prevJobStatus.current = jobProgress?.status;
  }, [jobProgress?.status]);

  // --- Suggest job polling ---
  const pollSuggestProgress = useCallback(async () => {
    try {
      const p = await dbService.fetchGroupFeatureSuggestProgress();
      setSuggestProgress(p);
      const isActive = p.status === 'queued' || p.status === 'running';
      suggestPollRef.current = setTimeout(pollSuggestProgress, isActive ? 2000 : 10000);
    } catch {
      suggestPollRef.current = setTimeout(pollSuggestProgress, 10000);
    }
  }, []);

  useEffect(() => {
    pollSuggestProgress();
    return () => { if (suggestPollRef.current) clearTimeout(suggestPollRef.current); };
  }, [pollSuggestProgress]);

  const prevSuggestStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevSuggestStatus.current === 'running' && suggestProgress?.status === 'completed') {
      fetchList(page, search, filterGroups, filterFeatureIds, filterStatuses, sortBy, sortDir, filterTargetAttrs, filterTargetVals);
    }
    prevSuggestStatus.current = suggestProgress?.status;
  }, [suggestProgress?.status]);

  // --- Upload CSV ---
  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploading(true);
    setUploadResult(null);
    try {
      const text = await file.text();
      const parsed = parseCSV(text);
      if (parsed.length < 1) throw new Error('CSV must have a header row and at least one data row');

      const payloadRows: Record<string, string>[] = parsed;

      const result = await dbService.uploadGroupFeatures(payloadRows);
      setUploadResult(result);
      fetchList(0, search, filterGroups, filterFeatureIds, filterStatuses, sortBy, sortDir);
      setPage(0);
      loadFilters();
    } catch (err: any) {
      alert(`Upload failed: ${err.message}`);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [search, filterGroups, filterFeatureIds, filterStatuses, fetchList, loadFilters]);

  // --- Trigger mapping job ---
  const handleTriggerMapping = useCallback(async () => {
    setIsTriggering(true);
    try {
      await dbService.triggerGroupFeatureMappingJob();
      const p = await dbService.fetchGroupFeatureMappingProgress();
      setJobProgress(p);
    } catch (err: any) {
      alert(`Trigger failed: ${err.message}`);
    } finally {
      setIsTriggering(false);
    }
  }, []);

  const handleTriggerSuggest = useCallback(async () => {
    setIsSuggestTriggering(true);
    try {
      await dbService.triggerGroupFeatureSuggest();
      const p = await dbService.fetchGroupFeatureSuggestProgress();
      setSuggestProgress(p);
    } catch (err: any) {
      alert(`Trigger suggest failed: ${err.message}`);
    } finally {
      setIsSuggestTriggering(false);
    }
  }, []);

  // --- Select group for detail ---
  const handleSelectGroup = useCallback(async (groupName: string) => {
    if (selectedGroup === groupName) return;
    setSelectedGroup(groupName);
    setRightTab('subFeatures');
    setIsLoadingSubFeatures(true);
    setIsLoadingWhereUsed(false);
    setSubFeatures([]);
    setWhereUsedItems([]);
    setVlResult(null);
    setVlError(null);

    try {
      const result = await dbService.fetchGroupFeatures({ featureGroup: groupName, limit: 5000 });
      setSubFeatures(result.items);
    } catch { /* ignore */ }
    setIsLoadingSubFeatures(false);
  }, [selectedGroup]);

  // --- Load where-used ---
  const handleLoadWhereUsed = useCallback(async (groupName: string) => {
    setRightTab('whereUsed');
    setIsLoadingWhereUsed(true);
    try {
      const result = await dbService.fetchGroupFeatureWhereUsed(groupName);
      setWhereUsedItems(result.items);
      setWhereUsedTotal(result.total);
    } catch { /* ignore */ }
    setIsLoadingWhereUsed(false);
  }, []);

  // --- Generate valuelist ---
  const handleGenerateValuelist = useCallback(async () => {
    if (!selectedGroup) return;

    // Pre-validate: check if all non-discontinued values are approved
    const nonDisc = subFeatures.filter(sf => (sf.valueStatus || '').toLowerCase() !== 'discontinued');
    const notApproved = nonDisc.filter(sf => (sf.valueStatus || '').toLowerCase() !== 'approved');
    if (notApproved.length > 0) {
      const counts: Record<string, number> = {};
      notApproved.forEach(sf => {
        const st = sf.valueStatus || 'unknown';
        counts[st] = (counts[st] || 0) + 1;
      });
      const parts = Object.entries(counts).map(([st, n]) => `${n} ${st}`).join(', ');
      setVlError(`Cannot generate: ${parts} value(s) not approved. Approve all values first.`);
      setVlResult(null);
      return;
    }

    setVlError(null);
    setIsGeneratingVL(true);
    setVlResult(null);
    try {
      const result = await dbService.generateGroupFeatureValuelist(selectedGroup);
      setVlResult({ valuelistsCreated: result.valuelistsCreated, skippedFeatures: result.skippedFeatures });
      // Refresh sub-features to show updated valuelist_id
      const refreshed = await dbService.fetchGroupFeatures({ featureGroup: selectedGroup, limit: 5000 });
      setSubFeatures(refreshed.items);
      fetchList(page, search, filterGroups, filterFeatureIds, filterStatuses, sortBy, sortDir, filterTargetAttrs, filterTargetVals);
      fetchStats();
    } catch (err: any) {
      setVlError(`Generate valuelist failed: ${err.message}`);
    } finally {
      setIsGeneratingVL(false);
    }
  }, [selectedGroup, subFeatures, page, search, filterGroups, filterFeatureIds, filterStatuses, sortBy, sortDir, filterTargetAttrs, filterTargetVals, fetchList, fetchStats]);

  // --- Search handler ---
  const handleSearchSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
    setPage(0);
  }, [searchInput]);

  // --- Derive unique group names from current rows for quick summary ---
  const uniqueGroups = useMemo(() => {
    const gSet = new Set<string>();
    rows.forEach(r => gSet.add(r.featureGroup));
    return Array.from(gSet).sort();
  }, [rows]);

  const jobIsActive = jobProgress?.status === 'queued' || jobProgress?.status === 'running';
  const suggestIsActive = suggestProgress?.status === 'queued' || suggestProgress?.status === 'running';

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      {/* Header */}
      <div className="shrink-0 bg-white border-b border-slate-200 px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-black text-slate-800 uppercase tracking-wider">Group Features</h1>
          <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{total.toLocaleString()} rows</span>
          {jobProgress && jobIsActive && (
            <span className="text-[9px] font-bold text-blue-600 animate-pulse uppercase">
              Mapping {Math.round((jobProgress.progress || 0) * 100)}%
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {currentUser.role === 'admin' && (
            <>
              <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleUpload} />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                className="px-3 py-1.5 bg-blue-600 text-white rounded-md text-[9px] font-black uppercase tracking-wider hover:bg-blue-700 disabled:opacity-50"
              >
                {isUploading ? 'Uploading…' : 'Upload CSV'}
              </button>
              <button
                onClick={handleTriggerMapping}
                disabled={isTriggering || jobIsActive || total === 0}
                className="px-3 py-1.5 bg-violet-600 text-white rounded-md text-[9px] font-black uppercase tracking-wider hover:bg-violet-700 disabled:opacity-50"
              >
                {jobIsActive ? 'Mapping…' : 'Apply Mappings'}
              </button>
              <button
                onClick={handleTriggerSuggest}
                disabled={isSuggestTriggering || suggestIsActive || total === 0}
                className="px-3 py-1.5 bg-amber-600 text-white rounded-md text-[9px] font-black uppercase tracking-wider hover:bg-amber-700 disabled:opacity-50"
              >
                {suggestIsActive ? 'Suggesting…' : 'AI Suggest'}
              </button>
            </>
          )}
          {total > 0 && (
            <button
              onClick={async () => {
                setIsExporting(true);
                try {
                  await dbService.downloadGroupFeaturesCsv({
                    search: search || undefined,
                    featureGroup: filterGroups.length ? filterGroups.join(',') : undefined,
                    featureId: filterFeatureIds.length ? filterFeatureIds.join(',') : undefined,
                    valueStatus: filterStatuses.length ? filterStatuses.join(',') : undefined,
                    targetAttribute: filterTargetAttrs.length ? filterTargetAttrs.join(',') : undefined,
                    targetValue: filterTargetVals.length ? filterTargetVals.join(',') : undefined,
                  });
                } finally {
                  setIsExporting(false);
                }
              }}
              disabled={isExporting}
              className="px-3 py-1.5 bg-emerald-600 text-white rounded-md text-[9px] font-black uppercase tracking-wider hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1"
            >
              {isExporting && <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              {isExporting ? 'Exporting…' : 'Export CSV'}
            </button>
          )}
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-slate-100 text-slate-600 rounded-md text-[9px] font-black uppercase tracking-wider hover:bg-slate-200"
          >
            Close
          </button>
        </div>
      </div>

      {/* Upload result banner */}
      {uploadResult && (
        <div className="shrink-0 bg-emerald-50 border-b border-emerald-200 px-5 py-2 flex items-center gap-2">
          <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-xs font-bold text-emerald-700">Uploaded {uploadResult.rowsInserted.toLocaleString()} rows</span>
          <button onClick={() => setUploadResult(null)} className="ml-auto text-emerald-500 hover:text-emerald-700 text-xs font-bold">✕</button>
        </div>
      )}

      {/* Stats bar */}
      {stats && (
        <div className="shrink-0 bg-slate-50 border-b border-slate-200 px-5 py-1.5 flex items-center gap-4 flex-wrap">
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
            Groups: <span className="text-slate-700">{stats.totalGroups.toLocaleString()}</span>
          </span>
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
            Sub-Features: <span className="text-slate-700">{stats.totalSubFeatures.toLocaleString()}</span>
          </span>
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
            Values: <span className="text-slate-700">{stats.totalValues.toLocaleString()}</span>
          </span>
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
            Where Used: <span className="text-blue-700">{stats.totalWhereUsed.toLocaleString()} items</span>
          </span>
          {Object.entries(stats.statusCounts).sort(([a], [b]) => a.localeCompare(b)).map(([st, cnt]) => (
            <span key={st} className="text-[9px] font-bold uppercase tracking-wider">
              <span className={`inline-block px-1 py-0.5 rounded ${statusColor(st)}`}>{st}: {cnt.toLocaleString()}</span>
            </span>
          ))}
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
            Unmapped: <span className="text-red-600">{stats.unmappedAttributes.toLocaleString()}</span>
          </span>
        </div>
      )}

      {/* Job progress bar */}
      {jobIsActive && jobProgress && (
        <div className="shrink-0 bg-violet-50 border-b border-violet-200 px-5 py-2">
          <div className="flex items-center gap-3 text-[9px] font-bold text-violet-700 uppercase tracking-wider mb-1">
            <div className="w-3 h-3 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
            <span>Applying global mappings — {jobProgress.processedFeatures}/{jobProgress.totalFeatures} features — {jobProgress.generatedRows} mapped</span>
          </div>
          <div className="w-full bg-violet-200 rounded-full h-1.5">
            <div className="bg-violet-600 h-1.5 rounded-full transition-all" style={{ width: `${Math.round((jobProgress.progress || 0) * 100)}%` }} />
          </div>
        </div>
      )}

      {/* Suggest progress bar */}
      {suggestIsActive && suggestProgress && (
        <div className="shrink-0 bg-amber-50 border-b border-amber-200 px-5 py-2">
          <div className="flex items-center gap-3 text-[9px] font-bold text-amber-700 uppercase tracking-wider mb-1">
            <div className="w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            <span>Computing AI suggestions — {suggestProgress.processedFeatures}/{suggestProgress.totalFeatures} features — {suggestProgress.generatedRows} updated</span>
          </div>
          <div className="w-full bg-amber-200 rounded-full h-1.5">
            <div className="bg-amber-600 h-1.5 rounded-full transition-all" style={{ width: `${Math.round((suggestProgress.progress || 0) * 100)}%` }} />
          </div>
        </div>
      )}

      {/* Bulk action bar */}
      {isAdmin && selectedIds.size > 0 && (
        <div className="shrink-0 bg-blue-50 border-b border-blue-200 px-5 py-2 flex items-center gap-3">
          <span className="text-[9px] font-black text-blue-700 uppercase tracking-wider">{selectedIds.size} selected</span>
          <button
            onClick={() => { setShowBulkAttr(true); setShowBulkStatus(false); }}
            disabled={isBulkUpdating}
            className="px-3 py-1 bg-blue-600 text-white rounded text-[9px] font-black uppercase tracking-wider hover:bg-blue-700"
          >
            Set Target Attribute
          </button>
          <button
            onClick={() => { setShowBulkStatus(true); setShowBulkAttr(false); }}
            disabled={isBulkUpdating}
            className="px-3 py-1 bg-emerald-600 text-white rounded text-[9px] font-black uppercase tracking-wider hover:bg-emerald-700"
          >
            Set Status
          </button>
          <button
            onClick={clearBulkSelection}
            disabled={isBulkUpdating}
            className="px-3 py-1 bg-slate-200 text-slate-600 rounded text-[9px] font-black uppercase tracking-wider hover:bg-slate-300"
          >
            Clear Selection
          </button>
          {showBulkAttr && (
            <div className="relative">
              <InlineSearchDropdown
                value={null}
                fetchOptions={fetchAttrOptions}
                onSave={(val) => { if (val) handleBulkSetAttribute(val); else setShowBulkAttr(false); }}
                placeholder="Search attribute…"
                autoOpen
              />
              {isBulkUpdating && (
                <span className="ml-2 text-[9px] text-blue-600 font-bold animate-pulse">Updating…</span>
              )}
            </div>
          )}
          {showBulkStatus && (
            <div className="relative">
              <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-md shadow-lg py-1 w-36 z-30">
                {STATUS_OPTIONS.map(status => (
                  <button
                    key={status}
                    type="button"
                    onClick={() => handleBulkSetStatus(status)}
                    disabled={isBulkUpdating}
                    className="block w-full text-left px-3 py-1.5 text-xs font-bold uppercase hover:bg-slate-50 disabled:opacity-50"
                  >
                    <span className={`inline-block px-1.5 py-0.5 rounded ${statusColor(status)}`}>{status}</span>
                  </button>
                ))}
              </div>
              {isBulkUpdating && (
                <span className="ml-2 text-[9px] text-blue-600 font-bold animate-pulse">Updating…</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="shrink-0 bg-slate-50 border-b border-slate-200 px-5 py-2 flex items-center gap-3 flex-wrap">
        <form onSubmit={handleSearchSubmit} className="flex items-center gap-1">
          <input
            type="text"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search…"
            className="px-2 py-1.5 border border-slate-200 rounded-md text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 w-48"
          />
          <button type="submit" className="px-2 py-1.5 bg-slate-200 rounded-md text-xs font-bold hover:bg-slate-300">Go</button>
        </form>
        <MultiSelectDropdown label="Group" options={filterOptions.featureGroups} selected={filterGroups} onChange={v => { setFilterGroups(v); setPage(0); }} />
        <MultiSelectDropdown label="Feature ID" options={filterOptions.featureIds} selected={filterFeatureIds} onChange={v => { setFilterFeatureIds(v); setPage(0); }} />
        <MultiSelectDropdown label="Status" options={filterOptions.valueStatuses} selected={filterStatuses} onChange={v => { setFilterStatuses(v); setPage(0); }} />
        <MultiSelectDropdown label="Target Attr" options={filterOptions.targetAttributes} selected={filterTargetAttrs} onChange={v => { setFilterTargetAttrs(v); setPage(0); }} />
        <MultiSelectDropdown label="Target Val" options={filterOptions.targetValues} selected={filterTargetVals} onChange={v => { setFilterTargetVals(v); setPage(0); }} />

        {/* Column visibility toggle */}
        <div className="relative" ref={colMenuRef}>
          <button
            onClick={() => setShowColMenu(v => !v)}
            className="px-2 py-1.5 bg-slate-200 rounded-md text-[9px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-300 flex items-center gap-1"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7" /></svg>
            Columns
          </button>
          {showColMenu && (
            <div className="absolute left-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1 w-44">
              {ALL_COLUMNS.map(c => (
                <label key={c.key} className="flex items-center gap-2 px-3 py-1 hover:bg-slate-50 cursor-pointer text-xs text-slate-700">
                  <input type="checkbox" checked={visibleCols.has(c.key)} onChange={() => toggleCol(c.key)} className="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                  {c.label}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Main content */}
      <div ref={containerRef} className="flex flex-1 overflow-hidden">
        {/* Left: Table */}
        <div className="flex flex-col overflow-hidden" style={{ width: `calc(100% - ${rightPanelWidth}px)`, minWidth: MIN_LEFT_W }}>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr>
                  {isAdmin && (
                    <th className="px-2 py-2 border-b border-slate-200 w-8">
                      <input
                        type="checkbox"
                        checked={rows.length > 0 && selectedIds.size === rows.length}
                        onChange={toggleSelectAll}
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      />
                    </th>
                  )}
                  {activeCols.map(c => (
                    <th
                      key={c.key}
                      className={`${c.align === 'center' ? 'text-center' : 'text-left'} px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200${c.sortKey ? ' cursor-pointer select-none' : ''}`}
                      onClick={c.sortKey ? () => handleSort(c.sortKey!) : undefined}
                    >
                      {c.label}{c.sortKey && <SortIcon col={c.sortKey} />}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={activeCols.length + (isAdmin ? 1 : 0)} className="text-center py-8">
                      <div className="flex items-center justify-center gap-2 text-slate-400">
                        <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        Loading…
                      </div>
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={activeCols.length + (isAdmin ? 1 : 0)} className="text-center py-8 text-slate-400">
                      {total === 0 ? 'No group features uploaded yet. Upload a CSV to start.' : 'No matches found.'}
                    </td>
                  </tr>
                ) : rows.map(r => (
                  <tr
                    key={r.id}
                    onClick={() => handleSelectGroup(r.featureGroup)}
                    className={`cursor-pointer border-b border-slate-100 transition-colors ${selectedGroup === r.featureGroup ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-slate-50'}`}
                  >
                    {isAdmin && (
                      <td className="px-2 py-1.5">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(r.id)}
                          onChange={(e) => { e.stopPropagation(); toggleSelectRow(r.id); }}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                      </td>
                    )}
                    {activeCols.map(c => (
                      <td key={c.key} className={`px-3 py-1.5${c.align === 'center' ? ' text-center' : ''}`}>{c.render(r, columnCallbacks)}</td>
                    ))}
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

        {/* Right panel: Sub-features + Where-used */}
        <div style={{ width: rightPanelWidth, minWidth: MIN_RIGHT_W }} className="flex flex-col overflow-hidden bg-white shrink-0">
          {/* Panel header with tabs */}
          <div className="border-b border-slate-200 bg-slate-50 shrink-0">
            <div className="px-4 pt-2.5 pb-0">
              <h2 className="text-[9px] font-black uppercase tracking-wider text-slate-500 mb-2">
                {selectedGroup ? selectedGroup : 'Select a group feature'}
              </h2>
              {selectedGroup && (
                <div className="flex gap-0 border-b-0">
                  <button
                    onClick={() => setRightTab('subFeatures')}
                    className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-wider border-b-2 transition-colors ${rightTab === 'subFeatures' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
                  >
                    Sub-Features ({subFeatures.length})
                  </button>
                  <button
                    onClick={() => { setRightTab('whereUsed'); if (whereUsedItems.length === 0) handleLoadWhereUsed(selectedGroup); }}
                    className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-wider border-b-2 transition-colors ${rightTab === 'whereUsed' ? 'border-emerald-500 text-emerald-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
                  >
                    Where Used ({whereUsedTotal})
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-auto">
            {!selectedGroup ? (
              <div className="flex items-center justify-center h-full text-slate-300 text-xs">
                <div className="text-center">
                  <svg className="w-8 h-8 mx-auto mb-2 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  Click a row to see sub-features and where used
                </div>
              </div>
            ) : rightTab === 'subFeatures' ? (
              isLoadingSubFeatures ? (
                <div className="flex items-center justify-center h-32">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : subFeatures.length === 0 ? (
                <div className="text-center py-8 text-slate-400 text-xs">No sub-features found</div>
              ) : (
                <div>
                  {/* Valuelist action bar */}
                  {isAdmin && (
                    <div className="px-3 py-2 border-b border-slate-100 flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleGenerateValuelist}
                          disabled={isGeneratingVL}
                          className="px-2.5 py-1 bg-emerald-600 text-white rounded text-[9px] font-black uppercase tracking-wider hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {isGeneratingVL ? 'Generating…' : 'Generate Valuelist'}
                        </button>
                        {vlResult && (
                          <span className="text-[9px] text-emerald-600 font-bold">
                            {vlResult.valuelistsCreated} created{vlResult.skippedFeatures.length > 0 && `, ${vlResult.skippedFeatures.length} skipped`}
                          </span>
                        )}
                      </div>
                      {vlError && (
                        <span className="text-[9px] font-bold text-red-600 bg-red-50 px-2 py-1 rounded">{vlError}</span>
                      )}
                    </div>
                  )}
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Feature</th>
                        <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Option</th>
                        <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Target</th>
                        <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Value</th>
                        <th className="text-center px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Status</th>
                        <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">VL ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {subFeatures.map(sf => (
                        <tr key={sf.id} className="border-b border-slate-50 hover:bg-slate-50">
                          <td className="px-3 py-1.5 font-medium text-blue-700">{sf.featureId}</td>
                          <td className="px-3 py-1.5 text-slate-600">{sf.option || '—'}</td>
                          <td className="px-3 py-1.5 font-medium text-emerald-700">{sf.targetAttribute || '—'}</td>
                          <td className="px-3 py-1.5 text-slate-600">{sf.targetValue || '—'}</td>
                          <td className="px-3 py-1.5 text-center">
                            <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${statusColor(sf.valueStatus)}`}>
                              {sf.valueStatus}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-slate-400 text-[10px]">{sf.valuelistId || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : (
              /* Where Used tab */
              isLoadingWhereUsed ? (
                <div className="flex items-center justify-center h-32">
                  <div className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : whereUsedItems.length === 0 ? (
                <div className="text-center py-8 text-slate-400 text-xs">No items found using this group feature</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Item ID</th>
                      <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Description</th>
                      <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Category</th>
                      <th className="text-center px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Priority</th>
                      <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Product Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {whereUsedItems.map(item => (
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default GroupFeatures;
