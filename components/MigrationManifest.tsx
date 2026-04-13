import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MergedWorkspaceMappingDetail,
  MergedWorkspaceMappingRow,
  MergeJob,
  MigrationManifestAttributeGroup,
  MigrationManifestFilters,
  MigrationManifestItemSummary,
  MigrationManifestRow,
  MigrationManifestValueDetail,
  TargetAttributeProfile,
  User,
  ValuelistDedupGroup,
  ValuelistMergeProposal,
  ValuelistStrategyJob,
} from '../types';
import { dbService } from '../services/dbService';

interface MigrationManifestProps {
  currentUser: User;
  onClose: () => void;
}

const PAGE_SIZE = 20;
const MIN_LEFT_W = 360;
const MIN_RIGHT_W = 340;

const DONUT_COLORS = [
  '#3b82f6', '#8b5cf6', '#f97316', '#22c55e', '#06b6d4',
  '#ec4899', '#eab308', '#14b8a6', '#ef4444', '#6366f1',
  '#84cc16', '#f59e0b',
];

interface SegmentedDonutSlice {
  label: string;
  value: number;
  color: string;
  extra?: string;
}

const SegmentedDonut: React.FC<{
  title: string;
  slices: SegmentedDonutSlice[];
  centerLabel?: string;
  centerValue?: string;
}> = ({ title, slices, centerLabel, centerValue }) => {
  const size = 160;
  const strokeWidth = 20;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = slices.reduce((s, sl) => s + sl.value, 0);
  const [hovered, setHovered] = React.useState<number | null>(null);

  let cumulative = 0;
  const arcs = slices.map((sl) => {
    const frac = total > 0 ? sl.value / total : 0;
    const dash = circumference * frac;
    const gap = circumference - dash;
    const offset = -circumference * cumulative;
    cumulative += frac;
    return { ...sl, dash, gap, offset, frac };
  });

  return (
    <div className="flex flex-col items-center p-3 rounded-xl border border-slate-100 shadow-sm bg-white">
      <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2">{title}</div>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size}>
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            <circle cx={size / 2} cy={size / 2} r={radius} stroke="#f1f5f9" strokeWidth={strokeWidth} fill="none" />
            {arcs.map((a, i) => (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                stroke={a.color}
                strokeWidth={hovered === i ? strokeWidth + 4 : strokeWidth}
                fill="none"
                strokeDasharray={`${a.dash} ${a.gap}`}
                strokeDashoffset={a.offset}
                style={{ transition: 'stroke-width 0.15s', cursor: 'pointer' }}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
              />
            ))}
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          {hovered !== null ? (
            <>
              <span className="text-lg font-black text-slate-900">{Math.round(arcs[hovered].frac * 100)}%</span>
              <span className="text-[8px] font-bold text-slate-500 uppercase tracking-wider text-center px-2 leading-tight max-w-[90px] truncate">{arcs[hovered].label}</span>
            </>
          ) : (
            <>
              <span className="text-lg font-black text-slate-900">{centerValue ?? total.toLocaleString()}</span>
              <span className="text-[8px] font-bold text-slate-400 uppercase tracking-wider">{centerLabel ?? 'items'}</span>
            </>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-0.5 max-w-[260px]">
        {arcs.map((a, i) => (
          <div
            key={i}
            className={`flex items-center gap-1 text-[9px] cursor-default transition-opacity ${hovered !== null && hovered !== i ? 'opacity-40' : ''}`}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: a.color }} />
            <span className="text-slate-600 font-medium truncate max-w-[80px]" title={a.label}>{a.label}</span>
            <span className="text-slate-400">{a.value}</span>
            {a.extra ? <span className="text-slate-300">({a.extra})</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
};

const ParetoChart: React.FC<{ data: { value: number }[]; barColor?: string; onHover?: (i: number | null) => void; hoveredIdx?: number | null }> = ({ data, barColor = '#3b82f6', onHover, hoveredIdx }) => {
  if (!data.length) return null;
  const H = 100, PT = 4, PB = 4, cH = H - PT - PB;
  const maxVal = data.reduce((m, d) => Math.max(m, d.value), 1);
  const total = data.reduce((s, d) => s + d.value, 0);
  const n = data.length;
  const W = Math.max(n * 10, 300);
  const slotW = W / n;
  const barW = Math.max(slotW - 1.5, 1);
  let cum = 0;
  const pts: string[] = [];
  data.forEach((d, i) => {
    cum += d.value;
    pts.push(`${(i + 0.5) * slotW},${PT + cH * (1 - cum / total)}`);
  });
  const ref80Y = PT + cH * 0.2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" style={{ height: H }}>
      {data.map((d, i) => {
        const bh = Math.max(1, cH * (d.value / maxVal));
        const x = i * slotW + 0.75;
        const y = PT + cH - bh;
        const isHov = hoveredIdx === i;
        return (
          <g key={i} onMouseEnter={() => onHover?.(i)} onMouseLeave={() => onHover?.(null)} style={{ cursor: 'pointer' }}>
            <rect x={x} y={y} width={barW} height={bh} fill={isHov ? '#1d4ed8' : barColor} opacity={isHov ? 1 : 0.65} rx={1} />
            {bh > 18 ? (
              <text x={x + barW / 2} y={y + bh / 2 + 3} fontSize={6} fill="white" textAnchor="middle" fontWeight="bold">{d.value}</text>
            ) : null}
          </g>
        );
      })}
      <line x1={0} y1={ref80Y} x2={W} y2={ref80Y} stroke="#cbd5e1" strokeWidth={0.75} strokeDasharray="3 3" />
      <text x={2} y={ref80Y - 2} fontSize={7} fill="#94a3b8">80%</text>
      <polyline points={pts.join(' ')} fill="none" stroke="#f97316" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
};

const CoverageBars: React.FC<{
  rows: { label: string; covered: number; total: number }[];
  barColor?: string;
  onRowClick?: (label: string) => void;
  selectedLabel?: string;
}> = ({ rows, barColor = '#22c55e', onRowClick, selectedLabel }) => (
  <div className="space-y-1">
    {rows.map(r => {
      const pct = r.total > 0 ? r.covered / r.total : 0;
      const isSelected = selectedLabel === r.label;
      return (
        <div
          key={r.label}
          className={`flex items-center gap-2 min-w-0 rounded px-1 -mx-1 transition-colors ${
            onRowClick ? 'cursor-pointer hover:bg-white/70' : ''
          } ${isSelected ? 'bg-blue-50 ring-1 ring-blue-200' : ''}`}
          onClick={() => onRowClick?.(r.label)}
        >
          <div className={`w-28 shrink-0 text-right text-[9px] truncate ${isSelected ? 'font-bold text-blue-700' : 'text-slate-500'}`}>{r.label}</div>
          <div className="flex-1 h-3 bg-slate-200 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: `${pct * 100}%`, background: isSelected ? '#3b82f6' : barColor }} />
          </div>
          <div className={`w-8 shrink-0 text-right text-[9px] font-bold ${isSelected ? 'text-blue-700' : 'text-slate-600'}`}>{Math.round(pct * 100)}%</div>
          <div className="w-20 shrink-0 text-[9px] text-slate-400">{r.covered.toLocaleString()}/{r.total.toLocaleString()}</div>
          {isSelected ? <span className="text-[8px] text-blue-400 shrink-0">◀ filtered</span> : null}
        </div>
      );
    })}
  </div>
);

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
  const [attributeType, setAttributeType] = useState('');
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
  const [mergedDetail, setMergedDetail] = useState<MergedWorkspaceMappingDetail | null>(null);
  const [isLoadingMerged, setIsLoadingMerged] = useState(false);
  const [mergedSummary, setMergedSummary] = useState<{ totalRows: number; distinctItems: number; metrics?: { emptyAttributeFootprints: number; uniqueAttributeFootprints: number; itemsWithCombo: number; maxComboSize: number; uniqueValueFootprints: number; emptyValueFootprintAttrs: number; itemsWithSharedVL: number; totalSharedVLAttrs: number; uniqueLegacyFeatureFootprints: number; emptyLegacyFeatureFootprints: number; uniqueLegacyValueFootprints: number; emptyLegacyValueFootprintAttrs: number; coveredLegacyValueFootprintAttrs: number; itemsWithAnyLegacyValue: number }; footprintItems?: { category: string; productType: string; priority: string; hasAttrFp: boolean; attrFp: string; count: number; classification: string }[]; filterOptions?: { categories: string[]; productTypes: string[]; priorities: string[]; classifications: string[] }; fpAttrLabels?: Record<string, string> }>({ totalRows: 0, distinctItems: 0 });
  const [fpFilterCategory, setFpFilterCategory] = useState('__all__');
  const [fpFilterProductType, setFpFilterProductType] = useState('__all__');
  const [fpFilterPriority, setFpFilterPriority] = useState('__all__');
  const [fpFilterClassification, setFpFilterClassification] = useState('__all__');
  const [paretoHovered, setParetoHovered] = useState<number | null>(null);
  const [showFpDashboard, setShowFpDashboard] = useState(false);
  const [showMetricsCards, setShowMetricsCards] = useState(true);
  const [rightTab, setRightTab] = useState<'mappings' | 'combo' | 'sharedvl' | 'legacycombo' | 'legacysharedvl'>('mappings');
  const [comboPage, setComboPage] = useState(0);
  const [legacyComboPage, setLegacyComboPage] = useState(0);
  const [relatedItemIds, setRelatedItemIds] = useState<string | null>(null);

  // Derived footprint content from mergedDetail mappings
  const footprintContent = useMemo(() => {
    const empty = { targetAttrs: [] as string[], legacyFeatures: [] as string[], targetValues: [] as string[], legacyValues: [] as string[] };
    if (!mergedDetail) return empty;
    // Use stored footprint component lists from the API (computed during batch job with correct type filters)
    const d = mergedDetail as Record<string, unknown>;
    const targetAttrs = (Array.isArray(d.footprintAttrs) ? d.footprintAttrs as string[] : []).filter(Boolean);
    const legacyFeatures = (Array.isArray(d.footprintLegacyFeatures) ? d.footprintLegacyFeatures as string[] : []).filter(Boolean);
    const targetValues = (Array.isArray(d.footprintValues) ? d.footprintValues as string[] : []).filter(Boolean);
    const legacyValues = (Array.isArray(d.footprintLegacyValues) ? d.footprintLegacyValues as string[] : []).filter(Boolean);
    return { targetAttrs, legacyFeatures, targetValues, legacyValues };
  }, [mergedDetail]);

  // Helper: get item IDs for current right tab (for "Show Related" filter)
  const getRelatedIds = useCallback(() => {
    if (!mergedDetail || !selectedItem) return null;
    const selfId = selectedItem.itemId;
    let ids: string[] = [];
    if (rightTab === 'combo') ids = mergedDetail.comboItems.map(c => c.itemId);
    else if (rightTab === 'sharedvl') ids = [...new Set(mergedDetail.sharedVL.flatMap(sv => sv.sharedItems))];
    else if (rightTab === 'legacycombo') ids = (mergedDetail.legacyComboItems ?? []).map(c => c.itemId);
    else if (rightTab === 'legacysharedvl') ids = [...new Set((mergedDetail.legacySharedVL ?? []).flatMap(sv => sv.sharedItems))];
    if (ids.length === 0) return null;
    if (!ids.includes(selfId)) ids = [selfId, ...ids];
    return ids.join(',');
  }, [mergedDetail, selectedItem, rightTab]);

  // Valuelist Strategy state
  const [showVlStrategy, setShowVlStrategy] = useState(false);
  const [vlJob, setVlJob] = useState<ValuelistStrategyJob | null>(null);
  const [vlProfiles, setVlProfiles] = useState<TargetAttributeProfile[]>([]);
  const [vlProfilesTotal, setVlProfilesTotal] = useState(0);
  const [vlDedupGroups, setVlDedupGroups] = useState<ValuelistDedupGroup[]>([]);
  const [vlMergeProposals, setVlMergeProposals] = useState<ValuelistMergeProposal[]>([]);
  const [vlStrategy, setVlStrategy] = useState<'conservative' | 'aggressive'>('conservative');
  const [isVlAnalyzing, setIsVlAnalyzing] = useState(false);
  const [isVlApplying, setIsVlApplying] = useState(false);
  const [vlClassFilter, setVlClassFilter] = useState('');
  const [vlSearchInput, setVlSearchInput] = useState('');
  const [vlStatusMessage, setVlStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const vlPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Merge Batch Job state
  const [mergeJob, setMergeJob] = useState<MergeJob | null>(null);
  const [isMergeJobRunning, setIsMergeJobRunning] = useState(false);
  const mergeJobPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [rightPanelWidth, setRightPanelWidth] = useState(480);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);

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
        attributeType: attributeType || undefined,
        hasMapping: hasMapping === '' ? undefined : hasMapping === 'true',
        itemIds: relatedItemIds || undefined,
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
  }, [page, search, category, productType, priority, attributeType, hasMapping, relatedItemIds, sortBy, sortDir, resetSelection]);

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
      const response = await dbService.fetchMergedWorkspaceMappingsDetail(itemId);
      setMergedDetail(response);
    } catch {
      setMergedDetail(null);
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
  }, [page, search, category, productType, priority, attributeType, hasMapping, relatedItemIds, sortBy, sortDir, loadItemSummaries]);

  useEffect(() => {
    if (selectedItem?.itemId) {
      loadAttributes(selectedItem.itemId);
    }
  }, [selectedItem?.itemId, loadAttributes]);

  useEffect(() => {
    if (selectedItem?.itemId) {
      loadMergedMappings(selectedItem.itemId);
      setComboPage(0);
      setLegacyComboPage(0);
    } else {
      setMergedDetail(null);
    }
  }, [selectedItem?.itemId, loadMergedMappings]);

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
      const itemsNote = (result as any).itemsUpdated > 1 ? ` across ${(result as any).itemsUpdated} shared items` : '';
      setStatusMessage({ type: 'success', text: `Saved ${result.mergedMappingsCreated + result.mergedMappingsUpdated} merged mapping(s)${itemsNote}.` });
    } catch (error: any) {
      setStatusMessage({ type: 'error', text: error?.message || 'Failed to save value merge selection.' });
    } finally {
      setIsSavingValue(false);
    }
  }, [refreshCurrentSelection, loadMergedSummary, selectedAttribute?.targetAttributeId, selectedItem?.itemId]);

  // ---------------------------------------------------------------------------
  // Merge Batch Job handlers
  // ---------------------------------------------------------------------------

  const loadMergeJobProgress = useCallback(async () => {
    try {
      const progress = await dbService.fetchMergeJobProgress();
      setMergeJob(progress);
      if (progress.hasJob && (progress.status === 'queued' || progress.status === 'running')) {
        setIsMergeJobRunning(true);
      } else {
        setIsMergeJobRunning(false);
      }
      return progress;
    } catch {
      return null;
    }
  }, []);

  const handleTriggerMergeJob = useCallback(async () => {
    setIsMergeJobRunning(true);
    try {
      const result = await dbService.triggerMergeJob();
      if (!result.ok) {
        setStatusMessage({ type: 'error', text: result.error || 'Failed to trigger merge job.' });
        setIsMergeJobRunning(false);
        return;
      }
      setStatusMessage({ type: 'success', text: 'Merge batch job started...' });
      // Start polling
      if (mergeJobPollRef.current) clearInterval(mergeJobPollRef.current);
      mergeJobPollRef.current = setInterval(async () => {
        const progress = await loadMergeJobProgress();
        if (progress && progress.hasJob && progress.status !== 'queued' && progress.status !== 'running') {
          if (mergeJobPollRef.current) clearInterval(mergeJobPollRef.current);
          mergeJobPollRef.current = null;
          if (progress.status === 'completed') {
            setStatusMessage({ type: 'success', text: `Merge job complete — ${progress.generatedRows ?? 0} rows, ${progress.processedItems ?? 0} items.` });
          } else {
            setStatusMessage({ type: 'error', text: `Merge job failed: ${progress.errorMessage || 'Unknown error'}` });
          }
          await loadMergedSummary();
          await loadItemSummaries(page, search);
        }
      }, 1500);
    } catch (error: any) {
      setStatusMessage({ type: 'error', text: error?.message || 'Failed to trigger merge job.' });
      setIsMergeJobRunning(false);
    }
  }, [loadMergeJobProgress, loadMergedSummary, loadItemSummaries, page, search]);

  // Load merge job progress on mount
  useEffect(() => {
    loadMergeJobProgress();
    return () => {
      if (mergeJobPollRef.current) clearInterval(mergeJobPollRef.current);
    };
  }, [loadMergeJobProgress]);

  // ---------------------------------------------------------------------------
  // Valuelist Strategy handlers
  // ---------------------------------------------------------------------------

  const loadVlProfiles = useCallback(async () => {
    try {
      const res = await dbService.fetchValuelistStrategyProfiles({
        classification: vlClassFilter || undefined,
        search: vlSearchInput || undefined,
        limit: 200,
      });
      setVlProfiles(res.items);
      setVlProfilesTotal(res.total);
    } catch { /* ignore */ }
  }, [vlClassFilter, vlSearchInput]);

  const loadVlDedupGroups = useCallback(async () => {
    try {
      const res = await dbService.fetchValuelistStrategyDedupGroups();
      setVlDedupGroups(res.groups);
    } catch { /* ignore */ }
  }, []);

  const loadVlMergePreview = useCallback(async () => {
    try {
      const res = await dbService.fetchValuelistStrategyMergePreview(vlStrategy);
      setVlMergeProposals(res.proposals);
    } catch { /* ignore */ }
  }, [vlStrategy]);

  const handleVlAnalyze = useCallback(async () => {
    setIsVlAnalyzing(true);
    setVlStatusMessage(null);
    try {
      const { jobId } = await dbService.triggerValuelistStrategyAnalysis(vlStrategy);
      // Poll job status
      const poll = setInterval(async () => {
        try {
          const job = await dbService.fetchValuelistStrategyJobStatus(jobId);
          setVlJob(job);
          if (job.status === 'completed' || job.status === 'failed') {
            clearInterval(poll);
            vlPollRef.current = null;
            setIsVlAnalyzing(false);
            if (job.status === 'completed') {
              setVlStatusMessage({ type: 'success', text: `Analysis complete: ${job.totalAttributes} attributes — ${job.fixedOnlyCount} fixed-only, ${job.valuelistCount} valuelist (${job.uniqueValuelists} unique after dedup)` });
              loadVlProfiles();
              loadVlDedupGroups();
              loadVlMergePreview();
            } else {
              setVlStatusMessage({ type: 'error', text: job.errorMessage || 'Analysis failed' });
            }
          }
        } catch {
          clearInterval(poll);
          vlPollRef.current = null;
          setIsVlAnalyzing(false);
        }
      }, 1500);
      vlPollRef.current = poll;
    } catch (error: any) {
      setIsVlAnalyzing(false);
      setVlStatusMessage({ type: 'error', text: error?.message || 'Failed to start analysis' });
    }
  }, [vlStrategy, loadVlProfiles, loadVlDedupGroups, loadVlMergePreview]);

  const handleVlApply = useCallback(async () => {
    setIsVlApplying(true);
    setVlStatusMessage(null);
    try {
      const result = await dbService.applyValuelistStrategy();
      setVlStatusMessage({ type: 'success', text: `Applied: ${result.valuelistsCreated} valuelists created, ${result.profilesUpdated} profiles updated, ${result.mappingsUpdated} mappings updated` });
      loadVlProfiles();
    } catch (error: any) {
      setVlStatusMessage({ type: 'error', text: error?.message || 'Failed to apply strategy' });
    } finally {
      setIsVlApplying(false);
    }
  }, [loadVlProfiles]);

  // Cleanup poll on unmount
  useEffect(() => {
    return () => {
      if (vlPollRef.current) clearInterval(vlPollRef.current);
    };
  }, []);

  // Reload profiles when filters change
  useEffect(() => {
    if (showVlStrategy) loadVlProfiles();
  }, [showVlStrategy, loadVlProfiles]);

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

  // Filtered footprint donut data
  const fpDonutData = useMemo(() => {
    const items = mergedSummary.footprintItems;
    if (!items || items.length === 0) return null;
    const filtered = items.filter(r =>
      (fpFilterCategory === '__all__' || r.category === fpFilterCategory) &&
      (fpFilterProductType === '__all__' || r.productType === fpFilterProductType) &&
      (fpFilterPriority === '__all__' || r.priority === fpFilterPriority) &&
      (fpFilterClassification === '__all__' || r.classification === fpFilterClassification)
    );
    const totalItems = filtered.reduce((s, r) => s + r.count, 0);
    const withAttrFp = filtered.filter(r => r.hasAttrFp).reduce((s, r) => s + r.count, 0);
    const withoutAttrFp = totalItems - withAttrFp;
    const uniqueAttrFps = new Set(filtered.filter(r => r.hasAttrFp).map(r => r.attrFp)).size;
    return { totalItems, withAttrFp, withoutAttrFp, uniqueAttrFps };
  }, [mergedSummary.footprintItems, fpFilterCategory, fpFilterProductType, fpFilterPriority, fpFilterClassification]);

  const paretoResult = useMemo(() => {
    const items = mergedSummary.footprintItems;
    if (!items?.length) return { data: [] as { value: number }[], totalPatterns: 0, idx80: 0, labels: [] as string[] };
    const filtered = items.filter(r =>
      (fpFilterCategory === '__all__' || r.category === fpFilterCategory) &&
      (fpFilterProductType === '__all__' || r.productType === fpFilterProductType) &&
      (fpFilterPriority === '__all__' || r.priority === fpFilterPriority) &&
      (fpFilterClassification === '__all__' || r.classification === fpFilterClassification) &&
      r.hasAttrFp
    );
    const byFp = new Map<string, number>();
    for (const r of filtered) byFp.set(r.attrFp, (byFp.get(r.attrFp) || 0) + r.count);
    const sorted = [...byFp.entries()].sort((a, b) => b[1] - a[1]);
    const totalPatterns = sorted.length;
    const data = sorted.slice(0, 40).map(([, v]) => ({ value: v }));
    const labels = sorted.slice(0, 40).map(([hash]) => mergedSummary.fpAttrLabels?.[hash] ?? '');
    const cumTotal = data.reduce((s, d) => s + d.value, 0);
    let cum = 0, idx80 = data.length - 1;
    for (let i = 0; i < data.length; i++) {
      cum += data[i].value;
      if (cum / Math.max(cumTotal, 1) >= 0.8) { idx80 = i; break; }
    }
    return { data, totalPatterns, idx80, labels };
  }, [mergedSummary.footprintItems, mergedSummary.fpAttrLabels, fpFilterCategory, fpFilterProductType, fpFilterPriority, fpFilterClassification]);

  const coverageByCategory = useMemo(() => {
    const items = mergedSummary.footprintItems;
    if (!items?.length) return [] as { label: string; covered: number; total: number }[];
    const isDrillDown = fpFilterCategory !== '__all__';
    const groupKey = isDrillDown ? 'productType' : 'category';
    const map = new Map<string, { covered: number; total: number }>();
    for (const r of items.filter(r =>
      (fpFilterCategory === '__all__' || r.category === fpFilterCategory) &&
      (fpFilterProductType === '__all__' || r.productType === fpFilterProductType) &&
      (fpFilterPriority === '__all__' || r.priority === fpFilterPriority) &&
      (fpFilterClassification === '__all__' || r.classification === fpFilterClassification)
    )) {
      const key = r[groupKey];
      const e = map.get(key) || { covered: 0, total: 0 };
      e.total += r.count;
      if (r.hasAttrFp) e.covered += r.count;
      map.set(key, e);
    }
    return [...map.entries()].map(([label, e]) => ({ label, ...e }))
      .sort((a, b) => (b.covered / Math.max(b.total, 1)) - (a.covered / Math.max(a.total, 1)));
  }, [mergedSummary.footprintItems, fpFilterCategory, fpFilterProductType, fpFilterPriority, fpFilterClassification]);

  const coverageByPriority = useMemo(() => {
    const items = mergedSummary.footprintItems;
    if (!items?.length) return [] as { label: string; covered: number; total: number }[];
    const prioMap = new Map<string, { covered: number; total: number }>();
    for (const r of items.filter(r =>
      (fpFilterCategory === '__all__' || r.category === fpFilterCategory) &&
      (fpFilterProductType === '__all__' || r.productType === fpFilterProductType) &&
      (fpFilterClassification === '__all__' || r.classification === fpFilterClassification)
    )) {
      const e = prioMap.get(r.priority) || { covered: 0, total: 0 };
      e.total += r.count;
      if (r.hasAttrFp) e.covered += r.count;
      prioMap.set(r.priority, e);
    }
    return [...prioMap.entries()].map(([label, e]) => ({ label, ...e }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [mergedSummary.footprintItems, fpFilterCategory, fpFilterProductType, fpFilterClassification]);

  const coverageByClassification = useMemo(() => {
    const items = mergedSummary.footprintItems;
    if (!items?.length) return [] as { label: string; covered: number; total: number }[];
    const map = new Map<string, { covered: number; total: number }>();
    for (const r of items.filter(r =>
      (fpFilterCategory === '__all__' || r.category === fpFilterCategory) &&
      (fpFilterProductType === '__all__' || r.productType === fpFilterProductType) &&
      (fpFilterPriority === '__all__' || r.priority === fpFilterPriority)
    )) {
      const key = r.productType || 'NA';
      const e = map.get(key) || { covered: 0, total: 0 };
      e.total += r.count;
      if (r.hasAttrFp) e.covered += r.count;
      map.set(key, e);
    }
    return [...map.entries()].map(([label, e]) => ({ label, ...e }))
      .sort((a, b) => (b.covered / Math.max(b.total, 1)) - (a.covered / Math.max(a.total, 1)));
  }, [mergedSummary.footprintItems, fpFilterCategory, fpFilterProductType, fpFilterPriority]);

  const paretoTableData = useMemo(() => {
    const items = mergedSummary.footprintItems;
    if (!items?.length) return [] as { rank: number; hash: string; label: string; count: number; topCats: [string, number][] }[];
    const filtered = items.filter(r =>
      (fpFilterCategory === '__all__' || r.category === fpFilterCategory) &&
      (fpFilterProductType === '__all__' || r.productType === fpFilterProductType) &&
      (fpFilterPriority === '__all__' || r.priority === fpFilterPriority) &&
      (fpFilterClassification === '__all__' || r.classification === fpFilterClassification) &&
      r.hasAttrFp
    );
    const byFp = new Map<string, { count: number; cats: Map<string, number> }>();
    for (const r of filtered) {
      const e = byFp.get(r.attrFp) || { count: 0, cats: new Map<string, number>() };
      e.count += r.count;
      e.cats.set(r.category, (e.cats.get(r.category) || 0) + r.count);
      byFp.set(r.attrFp, e);
    }
    return [...byFp.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 40)
      .map(([hash, e], i) => ({
        rank: i + 1,
        hash,
        label: mergedSummary.fpAttrLabels?.[hash] ?? hash.slice(0, 8),
        count: e.count,
        topCats: [...e.cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3) as [string, number][],
      }));
  }, [mergedSummary.footprintItems, mergedSummary.fpAttrLabels, fpFilterCategory, fpFilterProductType, fpFilterPriority, fpFilterClassification]);

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
          {mergedSummary.footprintItems && mergedSummary.footprintItems.length > 0 ? (
            <button
              onClick={() => setShowFpDashboard(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[9px] font-black uppercase tracking-wider transition-all ${showFpDashboard ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              Dashboard
            </button>
          ) : null}
          <button
            onClick={handleTriggerMergeJob}
            disabled={isMergeJobRunning}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[9px] font-black uppercase tracking-wider transition-all ${isMergeJobRunning ? 'bg-indigo-200 text-indigo-500 cursor-not-allowed' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {isMergeJobRunning ? `Running${mergeJob && mergeJob.totalItems && mergeJob.totalItems > 0 ? ` ${Math.round(((mergeJob.processedItems ?? 0) / mergeJob.totalItems) * 100)}%` : '...'}` : 'Run Batch Job'}
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

      {vlStatusMessage ? (
        <div className={`px-5 py-2 text-[11px] border-b shrink-0 ${vlStatusMessage.type === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-rose-50 text-rose-700 border-rose-100'}`}>
          {vlStatusMessage.text}
        </div>
      ) : null}

      {mergedSummary.metrics && mergedSummary.totalRows > 0 ? (
        <div className="px-5 py-3 bg-slate-50/60 border-b border-slate-200 shrink-0">
          <button
            onClick={() => setShowMetricsCards(v => !v)}
            className="flex items-center gap-1.5 mb-2 text-[9px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 transition-colors"
          >
            <svg className={`w-3 h-3 transition-transform ${showMetricsCards ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Footprint Metrics
          </button>
          {showMetricsCards ? <div className="space-y-3">

            {/* ── Target Metrics ── */}
            <div>
              <div className="text-[9px] font-black uppercase tracking-widest text-blue-500 mb-2 flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-sm bg-blue-400" />
                Target Metrics — based on mapped attributes &amp; values
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">

                <div className="rounded-xl bg-white border border-blue-50 shadow-sm p-3">
                  <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-0.5">Attribute Footprints</div>
                  <div className="text-[9px] text-slate-400 mb-1.5 leading-tight">Distinct target attribute sets per item</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xl font-black text-blue-700">{mergedSummary.metrics.uniqueAttributeFootprints.toLocaleString()}</span>
                    <span className="text-[10px] text-slate-400 font-medium">unique</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-[10px]">
                    {mergedSummary.metrics.emptyAttributeFootprints > 0 ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                        <span className="text-amber-700 font-bold">{mergedSummary.metrics.emptyAttributeFootprints.toLocaleString()}</span>
                        <span className="text-slate-400">items with no targets</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                        <span className="text-green-600 font-bold">All items covered</span>
                      </span>
                    )}
                    <span className="text-slate-300">·</span>
                    <span className="text-slate-500">{mergedSummary.distinctItems.toLocaleString()} items</span>
                  </div>
                </div>

                <div className="rounded-xl bg-white border border-blue-50 shadow-sm p-3">
                  <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-0.5">Combo Items</div>
                  <div className="text-[9px] text-slate-400 mb-1.5 leading-tight">Items sharing identical target attribute sets</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xl font-black text-sky-700">{mergedSummary.metrics.itemsWithCombo.toLocaleString()}</span>
                    <span className="text-[10px] text-slate-400 font-medium">items share a set</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-[10px]">
                    <span className="inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
                      <span className="text-sky-700 font-bold">{mergedSummary.metrics.maxComboSize.toLocaleString()}</span>
                      <span className="text-slate-400">largest group</span>
                    </span>
                    <span className="text-slate-300">·</span>
                    <span className="text-slate-500">{Math.round((mergedSummary.metrics.itemsWithCombo / Math.max(mergedSummary.distinctItems, 1)) * 100)}% of items</span>
                  </div>
                </div>

                <div className="rounded-xl bg-white border border-blue-50 shadow-sm p-3">
                  <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-0.5">Value Footprints</div>
                  <div className="text-[9px] text-slate-400 mb-1.5 leading-tight">Distinct mapped value sets per target attribute</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xl font-black text-teal-700">{mergedSummary.metrics.uniqueValueFootprints.toLocaleString()}</span>
                    <span className="text-[10px] text-slate-400 font-medium">unique</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-[10px]">
                    {mergedSummary.metrics.emptyValueFootprintAttrs > 0 ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                        <span className="text-amber-700 font-bold">{mergedSummary.metrics.emptyValueFootprintAttrs.toLocaleString()}</span>
                        <span className="text-slate-400">attr slots with no mapped values</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                        <span className="text-green-600 font-bold">All slots covered</span>
                      </span>
                    )}
                  </div>
                </div>

                <div className="rounded-xl bg-white border border-blue-50 shadow-sm p-3">
                  <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-0.5">Shared Value Lists</div>
                  <div className="text-[9px] text-slate-400 mb-1.5 leading-tight">Items that can reuse the same value list</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xl font-black text-emerald-700">{mergedSummary.metrics.itemsWithSharedVL.toLocaleString()}</span>
                    <span className="text-[10px] text-slate-400 font-medium">items</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-[10px]">
                    <span className="inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      <span className="text-emerald-700 font-bold">{mergedSummary.metrics.totalSharedVLAttrs.toLocaleString()}</span>
                      <span className="text-slate-400">reusable attr slots</span>
                    </span>
                    <span className="text-slate-300">·</span>
                    <span className="text-slate-500">{Math.round((mergedSummary.metrics.itemsWithSharedVL / Math.max(mergedSummary.distinctItems, 1)) * 100)}% of items</span>
                  </div>
                </div>

              </div>
            </div>

            {/* ── Legacy Metrics ── */}
            <div>
              <div className="text-[9px] font-black uppercase tracking-widest text-violet-500 mb-2 flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-sm bg-violet-400" />
                Legacy Metrics — based on source features &amp; values
              </div>
              <div className="grid grid-cols-2 md:grid-cols-2 gap-3">

                <div className="rounded-xl bg-white border border-violet-50 shadow-sm p-3">
                  <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-0.5">Feature Footprints</div>
                  <div className="text-[9px] text-slate-400 mb-1.5 leading-tight">Distinct source feature sets per item — how many unique "shapes" items came in with</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xl font-black text-violet-700">{mergedSummary.metrics.uniqueLegacyFeatureFootprints.toLocaleString()}</span>
                    <span className="text-[10px] text-slate-400 font-medium">unique shapes</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-[10px]">
                    {mergedSummary.metrics.emptyLegacyFeatureFootprints > 0 ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                        <span className="text-amber-700 font-bold">{mergedSummary.metrics.emptyLegacyFeatureFootprints.toLocaleString()}</span>
                        <span className="text-slate-400">items with no source features</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                        <span className="text-green-600 font-bold">All items have features</span>
                      </span>
                    )}
                    <span className="text-slate-300">·</span>
                    <span className="text-slate-500">{mergedSummary.distinctItems.toLocaleString()} items</span>
                  </div>
                </div>

                <div className="rounded-xl bg-white border border-violet-50 shadow-sm p-3">
                  <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-0.5">Value Footprints</div>
                  <div className="text-[9px] text-slate-400 mb-1.5 leading-tight">Distinct source value sets per feature — diversity of incoming data before mapping</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xl font-black text-rose-700">{mergedSummary.metrics.uniqueLegacyValueFootprints.toLocaleString()}</span>
                    <span className="text-[10px] text-slate-400 font-medium">unique patterns</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-[10px]">
                    {mergedSummary.metrics.emptyLegacyValueFootprintAttrs > 0 ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                        <span className="text-amber-700 font-bold">{mergedSummary.metrics.emptyLegacyValueFootprintAttrs.toLocaleString()}</span>
                        <span className="text-slate-400">feature slots with no feasible values</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                        <span className="text-green-600 font-bold">All slots have values</span>
                      </span>
                    )}
                  </div>
                </div>

              </div>
            </div>

          </div> : null}
        </div>
      ) : null}

      {showFpDashboard && fpDonutData && mergedSummary.footprintItems && mergedSummary.filterOptions && mergedSummary.totalRows > 0 && mergedSummary.metrics ? (
        <div className="px-5 py-4 bg-white border-b border-slate-200 shrink-0 overflow-y-auto animate-[slideDown_0.2s_ease-out]" style={{ maxHeight: '60vh' }}>

          {/* Filter bar */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">Filter</span>
            <select value={fpFilterCategory} onChange={e => setFpFilterCategory(e.target.value)} className="px-2 py-1 border border-slate-200 rounded text-[10px] bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
              <option value="__all__">All Categories</option>
              {mergedSummary.filterOptions.categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={fpFilterPriority} onChange={e => setFpFilterPriority(e.target.value)} className="px-2 py-1 border border-slate-200 rounded text-[10px] bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
              <option value="__all__">All Priorities</option>
              {mergedSummary.filterOptions.priorities.map(p => <option key={p} value={p}>Priority {p}</option>)}
            </select>
            <select value={fpFilterProductType} onChange={e => setFpFilterProductType(e.target.value)} className="px-2 py-1 border border-slate-200 rounded text-[10px] bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
              <option value="__all__">All Product Types</option>
              {mergedSummary.filterOptions.productTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={fpFilterClassification} onChange={e => setFpFilterClassification(e.target.value)} className="px-2 py-1 border border-slate-200 rounded text-[10px] bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
              <option value="__all__">All Classes</option>
              {(mergedSummary.filterOptions.classifications ?? []).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            {(fpFilterCategory !== '__all__' || fpFilterPriority !== '__all__' || fpFilterProductType !== '__all__' || fpFilterClassification !== '__all__') ? (
              <button onClick={() => { setFpFilterCategory('__all__'); setFpFilterPriority('__all__'); setFpFilterProductType('__all__'); setFpFilterClassification('__all__'); }} className="text-[9px] text-blue-600 hover:text-blue-800 font-bold uppercase">Clear</button>
            ) : null}
          </div>

          {/* Row 1: Coverage Funnel + Simplification + Reuse */}
          <div className="grid grid-cols-5 gap-3 mb-4">
            <div className="col-span-3 bg-slate-50 rounded-xl p-3">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-0.5">Coverage Funnel</div>
              <div className="text-[8px] text-slate-400 mb-2">How many items make it through each migration stage — drop between stages highlights where data gaps exist</div>
              {(() => {
                const m = mergedSummary.metrics!;
                const total = mergedSummary.distinctItems;
                const stages: { label: string; value: number; color: string }[] = [
                  { label: 'Total items', value: total, color: '#64748b' },
                  { label: 'Has source features', value: total - (m.emptyLegacyFeatureFootprints ?? 0), color: '#8b5cf6' },
                  { label: 'Has target attributes', value: total - (m.emptyAttributeFootprints ?? 0), color: '#3b82f6' },
                  { label: 'Has feasible values', value: m.itemsWithAnyLegacyValue ?? 0, color: '#22c55e' },
                ];
                return (
                  <div className="space-y-1.5">
                    {stages.map((s, i) => {
                      const pct = total > 0 ? s.value / total : 0;
                      const prev = i > 0 ? stages[i - 1].value : null;
                      const drop = prev !== null ? prev - s.value : null;
                      return (
                        <div key={i}>
                          {drop !== null && drop > 0 ? (
                            <div className="ml-40 mb-0.5">
                              <span className="text-[8px] text-amber-500 font-bold">↓ −{drop.toLocaleString()} items</span>
                            </div>
                          ) : null}
                          <div className="flex items-center gap-2">
                            <div className="w-40 shrink-0 text-right text-[9px] text-slate-500">{s.label}</div>
                            <div className="flex-1 h-5 bg-slate-200 rounded overflow-hidden">
                              <div className="h-full flex items-center justify-end pr-1.5 rounded" style={{ width: `${Math.max(pct * 100, 1)}%`, background: s.color }}>
                                <span className="text-[8px] font-black text-white">{s.value.toLocaleString()}</span>
                              </div>
                            </div>
                            <div className="w-8 shrink-0 text-right text-[9px] font-bold text-slate-600">{Math.round(pct * 100)}%</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            <div className="col-span-2 flex flex-col gap-3">
              <div className="bg-slate-50 rounded-xl p-3 flex-1">
                <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2">Simplification</div>
                {(() => {
                  const m = mergedSummary.metrics!;
                  const ratio = m.uniqueAttributeFootprints > 0 ? (m.uniqueLegacyFeatureFootprints / m.uniqueAttributeFootprints).toFixed(1) : '—';
                  return (
                    <div className="flex items-center justify-around">
                      <div className="text-center">
                        <div className="text-xl font-black text-violet-700">{m.uniqueLegacyFeatureFootprints.toLocaleString()}</div>
                        <div className="text-[8px] text-slate-400 leading-tight">source shapes</div>
                      </div>
                      <div className="text-slate-300 text-xl font-black">→</div>
                      <div className="text-center">
                        <div className="text-xl font-black text-blue-700">{m.uniqueAttributeFootprints.toLocaleString()}</div>
                        <div className="text-[8px] text-slate-400 leading-tight">target shapes</div>
                      </div>
                      <div className="text-center">
                        <div className="text-xl font-black text-emerald-600">{ratio}×</div>
                        <div className="text-[8px] text-slate-400 leading-tight">reduction</div>
                      </div>
                    </div>
                  );
                })()}
              </div>
              <div className="bg-slate-50 rounded-xl p-3 flex-1">
                <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2">Reuse Opportunity</div>
                {(() => {
                  const m = mergedSummary.metrics!;
                  const total = mergedSummary.distinctItems;
                  const batches: { label: string; value: number; color: string }[] = [
                    { label: 'Combo groups', value: m.itemsWithCombo, color: '#0ea5e9' },
                    { label: 'Shared value lists', value: m.itemsWithSharedVL, color: '#10b981' },
                    { label: 'Standalone', value: total - m.itemsWithCombo, color: '#94a3b8' },
                  ];
                  return (
                    <div className="space-y-1.5">
                      {batches.map(b => (
                        <div key={b.label} className="flex items-center gap-2">
                          <div className="w-28 shrink-0 text-right text-[9px] text-slate-500">{b.label}</div>
                          <div className="flex-1 h-3 bg-slate-200 rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${(b.value / Math.max(total, 1)) * 100}%`, background: b.color }} />
                          </div>
                          <div className="w-14 shrink-0 text-[9px] font-bold" style={{ color: b.color }}>{b.value.toLocaleString()}</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* Row 2: Classification + Priority coverage */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="bg-slate-50 rounded-xl p-3">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-0.5">Coverage by Product Type</div>
              <div className="text-[8px] text-slate-400 mb-2">% of items with at least one target attribute mapped, grouped by product type · click to filter</div>
              <CoverageBars
                rows={coverageByClassification}
                barColor="#8b5cf6"
                onRowClick={c => setFpFilterClassification(fpFilterClassification === c ? '__all__' : c)}
                selectedLabel={fpFilterClassification !== '__all__' ? fpFilterClassification : undefined}
              />
            </div>
            <div className="bg-slate-50 rounded-xl p-3">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-0.5">Coverage by Priority</div>
              <div className="text-[8px] text-slate-400 mb-2">Same as above, grouped by item priority — are high-priority items fully mapped? · click to filter</div>
              <CoverageBars
                rows={coverageByPriority}
                barColor="#3b82f6"
                onRowClick={p => setFpFilterPriority(fpFilterPriority === p ? '__all__' : p)}
                selectedLabel={fpFilterPriority !== '__all__' ? fpFilterPriority : undefined}
              />
            </div>
          </div>

          {/* Row 3: Pareto + Donuts */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 bg-slate-50 rounded-xl p-3">
              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-0.5">
                Attribute Footprint Distribution{paretoResult.totalPatterns > 40 ? ` (top 40 of ${paretoResult.totalPatterns})` : ` (${paretoResult.totalPatterns} patterns)`}
              </div>
              <div className="text-[8px] text-slate-400 mb-1">Each bar = one unique set of target attributes shared by multiple items · a tall bar means many items share that exact set · hover a bar or table row to highlight</div>
              <ParetoChart data={paretoResult.data} hoveredIdx={paretoHovered} onHover={setParetoHovered} />
              {paretoResult.data.length > 0 ? (
                <div className="text-[9px] text-slate-500 mt-0.5 mb-2">
                  <span className="font-bold text-slate-700">{paretoResult.idx80 + 1}</span> pattern{paretoResult.idx80 > 0 ? 's cover' : ' covers'} 80% of items
                </div>
              ) : null}
              {paretoTableData.length > 0 ? (
                <div className="overflow-y-auto" style={{ maxHeight: '12rem' }}>
                  <table className="w-full text-[9px] border-collapse">
                    <thead>
                      <tr className="text-slate-400 uppercase tracking-widest border-b border-slate-200">
                        <th className="text-right pr-2 w-6 pb-1 font-semibold">#</th>
                        <th className="text-left pb-1 font-semibold">Attribute Set</th>
                        <th className="text-right pr-2 pb-1 font-semibold">Items</th>
                        <th className="text-left pb-1 font-semibold">Top Categories</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paretoTableData.map((row, i) => (
                        <tr
                          key={row.hash}
                          className={`border-b border-slate-100 cursor-pointer transition-colors ${paretoHovered === i ? 'bg-blue-50' : 'hover:bg-slate-100'}`}
                          onMouseEnter={() => setParetoHovered(i)}
                          onMouseLeave={() => setParetoHovered(null)}
                        >
                          <td className="text-right pr-2 text-slate-400 font-bold py-0.5">{row.rank}</td>
                          <td className="py-0.5 text-slate-600 font-medium max-w-[180px] truncate" title={row.label}>{row.label}</td>
                          <td className="text-right pr-2 font-bold text-blue-700">{row.count.toLocaleString()}</td>
                          <td className="text-slate-400 truncate max-w-[140px]" title={row.topCats.map(([cat, n]) => `${cat} (${n})`).join(', ')}>{row.topCats.map(([cat, n]) => `${cat} (${n})`).join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
            <div className="space-y-3">
              <SegmentedDonut
                title="Attribute Footprint Coverage"
                centerValue={fpDonutData.totalItems.toLocaleString()}
                centerLabel="items"
                slices={[
                  { label: 'With Footprint', value: fpDonutData.withAttrFp, color: '#22c55e', extra: `${fpDonutData.uniqueAttrFps} unique` },
                  { label: 'Empty', value: fpDonutData.withoutAttrFp, color: '#f59e0b' },
                ]}
              />
              <SegmentedDonut
                title="Legacy Feature Coverage"
                centerValue={mergedSummary.metrics.uniqueLegacyFeatureFootprints.toLocaleString()}
                centerLabel="item shapes"
                slices={[
                  { label: 'With Footprint', value: fpDonutData.totalItems - mergedSummary.metrics.emptyLegacyFeatureFootprints, color: '#8b5cf6', extra: `${mergedSummary.metrics.uniqueLegacyFeatureFootprints} unique` },
                  { label: 'No Source Features', value: mergedSummary.metrics.emptyLegacyFeatureFootprints, color: '#f59e0b' },
                ]}
              />
            </div>
          </div>
        </div>
      ) : null}

      {showVlStrategy ? (
        <div className="border-b border-teal-200 bg-teal-50/30 shrink-0 overflow-auto" style={{ maxHeight: '50vh' }}>
          <div className="px-5 py-3">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="text-[9px] font-black uppercase tracking-wider text-teal-700">Value List Setup</div>
                <div className="text-[11px] text-slate-500">Classify target attributes, deduplicate value sets, and optionally merge near-identical lists.</div>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={vlStrategy}
                  onChange={(e) => setVlStrategy(e.target.value as 'conservative' | 'aggressive')}
                  className="px-2 py-1 border border-teal-300 rounded text-[10px] bg-white focus:outline-none focus:ring-1 focus:ring-teal-400"
                >
                  <option value="conservative">Safe — no extra values added</option>
                  <option value="aggressive">Merge similar lists</option>
                </select>
                <button
                  onClick={handleVlAnalyze}
                  disabled={isVlAnalyzing}
                  className="px-3 py-1.5 rounded-md bg-teal-600 text-white text-[9px] font-black uppercase tracking-wider hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isVlAnalyzing ? 'Analyzing...' : 'Analyze'}
                </button>
                <button
                  onClick={handleVlApply}
                  disabled={isVlApplying || !vlJob || vlJob.status !== 'completed'}
                  className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-[9px] font-black uppercase tracking-wider hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isVlApplying ? 'Applying...' : 'Apply Strategy'}
                </button>
              </div>
            </div>

            {vlJob ? (
              <div className="mb-3 flex items-center gap-4 text-[11px]">
                <span className={`px-2 py-0.5 rounded-full font-bold text-[9px] uppercase ${vlJob.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : vlJob.status === 'running' ? 'bg-blue-100 text-blue-700' : vlJob.status === 'failed' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-700'}`}>{vlJob.status}</span>
                <span className="text-slate-600"><span className="font-bold">{vlJob.totalAttributes}</span> attributes</span>
                <span className="text-green-700"><span className="font-bold">{vlJob.fixedOnlyCount}</span> fixed</span>
                <span className="text-blue-700"><span className="font-bold">{vlJob.valuelistCount}</span> multi-value</span>
                <span className="text-teal-700"><span className="font-bold">{vlJob.uniqueValuelists}</span> unique after dedup</span>
                {vlJob.mergedValuelists != null ? <span className="text-purple-700"><span className="font-bold">{vlJob.mergedValuelists}</span> after merge</span> : null}
              </div>
            ) : null}

            {vlProfiles.length > 0 ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Search attributes..."
                    value={vlSearchInput}
                    onChange={(e) => setVlSearchInput(e.target.value)}
                    className="px-2 py-1 border border-teal-200 rounded text-[10px] bg-white focus:outline-none focus:ring-1 focus:ring-teal-400 w-48"
                  />
                  <select
                    value={vlClassFilter}
                    onChange={(e) => setVlClassFilter(e.target.value)}
                    className="px-2 py-1 border border-teal-200 rounded text-[10px] bg-white focus:outline-none focus:ring-1 focus:ring-teal-400"
                  >
                    <option value="">All Classifications</option>
                    <option value="fixed_only">Fixed Only</option>
                    <option value="valuelist">Valuelist</option>
                  </select>
                  <span className="ml-auto text-[10px] text-slate-400">{vlProfilesTotal} profiles</span>
                </div>

                <div className="rounded-xl border border-teal-200 overflow-hidden">
                  <table className="w-full text-[11px]">
                    <thead className="bg-teal-50/70">
                      <tr>
                        <th className="text-left px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-teal-600 border-b border-teal-200">Target Attribute</th>
                        <th className="text-left px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-teal-600 border-b border-teal-200">Type</th>
                        <th className="text-right px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-teal-600 border-b border-teal-200">Items</th>
                        <th className="text-right px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-teal-600 border-b border-teal-200">Fixed</th>
                        <th className="text-right px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-teal-600 border-b border-teal-200">Multi</th>
                        <th className="text-left px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-teal-600 border-b border-teal-200">Valuelist</th>
                        <th className="text-right px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-teal-600 border-b border-teal-200">Values</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-teal-100">
                      {vlProfiles.map((p) => (
                        <tr key={p.id} className="hover:bg-teal-50/50">
                          <td className="px-3 py-1.5 text-slate-800 font-medium">{p.targetAttributeId}</td>
                          <td className="px-3 py-1.5">
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${p.classification === 'fixed_only' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>{p.classification === 'fixed_only' ? 'Single' : 'Multi'}</span>
                          </td>
                          <td className="px-3 py-1.5 text-right text-slate-600">{p.totalItems}</td>
                          <td className="px-3 py-1.5 text-right text-green-700 font-bold">{p.fixedValueItems}</td>
                          <td className="px-3 py-1.5 text-right text-blue-700 font-bold">{p.multiValueItems}</td>
                          <td className="px-3 py-1.5 text-slate-500">{p.valuelistId || '—'}</td>
                          <td className="px-3 py-1.5 text-right text-slate-600">{p.canonicalValues?.length ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {vlDedupGroups.length > 0 ? (
                  <div className="mt-3">
                    <div className="text-[9px] font-black uppercase tracking-wider text-teal-700 mb-2">Shared Value Lists — {vlDedupGroups.length} groups</div>
                    <div className="space-y-2">
                      {vlDedupGroups.map((g) => (
                        <div key={g.dedupGroupKey} className="rounded-lg border border-teal-200 bg-white p-3">
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="text-[10px] font-bold text-teal-700">{g.valuelistId}</span>
                            <span className="text-[10px] text-slate-400">{g.attributes.length} attributes share this list</span>
                          </div>
                          <div className="flex flex-wrap gap-1 mb-2">
                            {g.canonicalValues.slice(0, 12).map((v) => (
                              <span key={v} className="px-1.5 py-0.5 rounded bg-teal-50 text-teal-700 text-[9px] font-medium">{v}</span>
                            ))}
                            {g.canonicalValues.length > 12 ? <span className="px-1.5 py-0.5 text-[9px] text-slate-400">+{g.canonicalValues.length - 12} more</span> : null}
                          </div>
                          <div className="text-[10px] text-slate-500">{g.attributes.map((a) => a.targetAttributeId).join(', ')}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {vlMergeProposals.length > 0 ? (
                  <div className="mt-3">
                    <div className="text-[9px] font-black uppercase tracking-wider text-purple-700 mb-2">Merge Suggestions — {vlMergeProposals.length} proposals</div>
                    <div className="space-y-2">
                      {vlMergeProposals.map((p, i) => (
                        <div key={i} className="rounded-lg border border-purple-200 bg-white p-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-[10px]">
                              <span className="font-bold text-purple-700">{p.listA}</span>
                              <span className="text-slate-400"> + </span>
                              <span className="font-bold text-purple-700">{p.listB}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] text-slate-500">{p.overlapPercent}% overlap</span>
                              {p.isSubset ? <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-700 text-[9px] font-bold">Subset</span> : null}
                            </div>
                          </div>
                          <div className="mt-1 text-[10px] text-slate-500">
                            Adding this merge would inject {p.noiseAddedToA} extra value{p.noiseAddedToA !== 1 ? 's' : ''} into {p.affectedItemsA} item{p.affectedItemsA !== 1 ? 's' : ''}, and {p.noiseAddedToB} extra value{p.noiseAddedToB !== 1 ? 's' : ''} into {p.affectedItemsB} item{p.affectedItemsB !== 1 ? 's' : ''}.
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {p.mergedValues.slice(0, 8).map((v) => (
                              <span key={v} className="px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 text-[9px] font-medium">{v}</span>
                            ))}
                            {p.mergedValues.length > 8 ? <span className="px-1.5 py-0.5 text-[9px] text-slate-400">+{p.mergedValues.length - 8} more</span> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
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
        <select value={attributeType} onChange={(event) => handleFilterChange(setAttributeType)(event.target.value)} className="px-3 py-1.5 border border-slate-200 rounded-md text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
          <option value="">All Attribute Types</option>
          {filters.attributeTypes.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <button
          onClick={() => {
            setSearchInput('');
            setSearch('');
            setCategory('');
            setProductType('');
            setPriority('');
            setAttributeType('');
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

      <div ref={containerRef} className="flex flex-row flex-1 overflow-hidden">
        <div className="flex flex-col flex-1 overflow-hidden">
          {relatedItemIds && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 border-b border-blue-200 shrink-0">
              <svg className="w-3.5 h-3.5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>
              <span className="text-[10px] font-bold text-blue-700">Showing {total} related items</span>
              <button onClick={() => setRelatedItemIds(null)} className="ml-auto text-[9px] font-bold text-blue-600 hover:text-blue-800 underline">Clear filter</button>
            </div>
          )}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr>
                  <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Item</th>
                  <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Category / Product</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('itemPriority')}>Priority{sortArrow('itemPriority')}</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('totalRows')}>Attrs{sortArrow('totalRows')}</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('comboItemCount')}>Shared Items{sortArrow('comboItemCount')}</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('sharedValuelistCount')}>Shared VL{sortArrow('sharedValuelistCount')}</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('legacyComboItemCount')}>Legacy Items{sortArrow('legacyComboItemCount')}</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200 cursor-pointer select-none hover:text-blue-600" onClick={() => handleSort('legacySharedVlCount')}>Legacy VL{sortArrow('legacySharedVlCount')}</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">FP Attrs</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">FP Values</th>
                  <th className="text-right px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Mapped</th>
                </tr>
              </thead>
              <tbody>
                {isLoadingItems ? (
                  <tr>
                    <td colSpan={11} className="text-center py-8">
                      <div className="flex items-center justify-center gap-2 text-slate-400">
                        <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        Loading items...
                      </div>
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="text-center py-8 text-slate-400">
                      {total === 0 ? 'No manifest built yet. Click "Build Manifest" to start.' : 'No matching items found.'}
                    </td>
                  </tr>
                ) : items.map((item) => (
                  <tr
                    key={item.itemId}
                    onClick={() => { setSelectedItem(item); setRightPanelOpen(true); }}
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
                    <td className="px-3 py-2 text-right"><span className="inline-flex items-center justify-center min-w-[30px] px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 text-[10px] font-bold">{item.sharedValuelistCount}</span></td>
                    <td className="px-3 py-2 text-right"><span className="inline-flex items-center justify-center min-w-[30px] px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 text-[10px] font-bold">{(item as any).legacyComboItemCount ?? 1}</span></td>
                    <td className="px-3 py-2 text-right"><span className="inline-flex items-center justify-center min-w-[30px] px-2 py-0.5 rounded-full bg-fuchsia-50 text-fuchsia-700 text-[10px] font-bold">{(item as any).legacySharedVlCount ?? 0}</span></td>
                    <td className="px-3 py-2 text-right"><span className="inline-flex items-center justify-center min-w-[44px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-[10px] font-bold">{(item as any).fpAttrMapped ?? 0}/{(item as any).fpAttrTotal ?? 0}</span></td>
                    <td className="px-3 py-2 text-right"><span className="inline-flex items-center justify-center min-w-[44px] px-2 py-0.5 rounded-full bg-cyan-50 text-cyan-700 text-[10px] font-bold">{(item as any).fpValueMapped ?? 0}/{(item as any).fpValueTotal ?? 0}</span></td>
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

        <div onMouseDown={handleMouseDown} className={`w-1.5 cursor-col-resize bg-slate-200 hover:bg-blue-400 active:bg-blue-500 transition-colors shrink-0 ${rightPanelOpen ? '' : 'hidden'}`} />

        {rightPanelOpen ? (
          <div style={{ width: rightPanelWidth, minWidth: MIN_RIGHT_W }} className="flex flex-col overflow-hidden bg-white border-l border-slate-200 shrink-0">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 shrink-0">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[9px] font-black uppercase tracking-wider text-slate-500">Merged Workspace Mappings</div>
                <button
                  onClick={() => setRightPanelOpen(false)}
                  className="p-1 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors"
                  title="Close panel"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {selectedItem ? (
                <>
                  <div className="mt-1 text-sm font-black text-slate-800">{selectedItem.itemId}</div>
                  <div className="text-[10px] text-slate-400">{selectedItem.itemDescription || 'No description'}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[10px] font-bold">{selectedItem.itemCategory || 'No category'}</span>
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[10px] font-bold">{selectedItem.itemProductType || 'No product type'}</span>
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-bold">P{selectedItem.itemPriority ?? '—'}</span>
                    {rightTab !== 'mappings' && (
                      <button
                        onClick={() => {
                          if (relatedItemIds) {
                            setRelatedItemIds(null);
                          } else {
                            const ids = getRelatedIds();
                            if (ids) { setRelatedItemIds(ids); setPage(0); }
                          }
                        }}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold transition-colors ${relatedItemIds ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'}`}
                        title={relatedItemIds ? 'Clear filter — show all items' : 'Filter table to show only related items'}
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>
                        {relatedItemIds ? 'Clear Filter' : 'Show Related'}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <div className="mt-1 text-[11px] text-slate-400">Select an item to view its mappings.</div>
              )}
            </div>

            {/* Tabs */}
            {selectedItem ? (
              <div className="flex border-b border-slate-200 bg-white shrink-0">
                {([['mappings', 'Mappings'], ['combo', 'Combo Items'], ['sharedvl', 'Shared VL'], ['legacycombo', 'Legacy Items'], ['legacysharedvl', 'Legacy VL']] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setRightTab(key)}
                    className={`flex-1 px-3 py-2 text-[9px] font-black uppercase tracking-wider transition-colors ${rightTab === key ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50/50' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
                  >
                    {label}
                    {key === 'combo' && mergedDetail ? ` (${mergedDetail.totalComboItems})` : ''}
                    {key === 'sharedvl' && mergedDetail ? ` (${mergedDetail.sharedVL?.length ?? 0})` : ''}
                    {key === 'legacycombo' && mergedDetail ? ` (${mergedDetail.totalLegacyComboItems ?? 0})` : ''}
                    {key === 'legacysharedvl' && mergedDetail ? ` (${mergedDetail.legacySharedVL?.length ?? 0})` : ''}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="flex-1 overflow-auto">
              {isLoadingMerged ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  Loading...
                </div>
              ) : !selectedItem ? (
                <div className="py-12 text-sm text-slate-400 text-center">Select an item from the table.</div>
              ) : !mergedDetail || mergedDetail.totalMappings === 0 ? (
                <div className="py-12 text-sm text-slate-400 text-center">No merged mappings for this item.</div>
              ) : rightTab === 'mappings' ? (
                <table className="w-full text-[11px]">
                  <thead className="bg-slate-50 sticky top-0 z-10">
                    <tr>
                      <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Legacy Feature</th>
                      <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Legacy Value</th>
                      <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">New Attribute</th>
                      <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Candidates</th>
                      <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">New Value</th>
                      <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Type</th>
                      <th className="text-left px-3 py-2 text-[9px] font-black uppercase tracking-wider text-slate-500 border-b border-slate-200">Feasibility</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {mergedDetail.mappings.map((row) => (
                      <tr key={row.id} className="hover:bg-slate-50">
                        <td className="px-3 py-1.5 text-slate-700 font-medium">{row.legacyFeatureId}</td>
                        <td className="px-3 py-1.5 text-slate-600">{row.legacyValue || '—'}</td>
                        <td className="px-3 py-1.5 text-slate-700">{row.newAttributeId || '—'}</td>
                        <td className="px-3 py-1.5">{row.candidateAttributeIds && row.candidateAttributeIds.length > 1 ? (
                          <span className="text-[9px] font-medium text-violet-600">{row.candidateAttributeIds.join('; ')}</span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}</td>
                        <td className="px-3 py-1.5 text-slate-600">{row.newValue || '—'}</td>
                        <td className="px-3 py-1.5"><span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[9px] font-bold">{row.attributeType || '—'}</span></td>
                        <td className="px-3 py-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${row.feasibility === 'Yes' ? 'bg-emerald-50 text-emerald-700' : row.feasibility === 'No' ? 'bg-rose-50 text-rose-600' : 'bg-slate-100 text-slate-500'}`}>
                            {row.feasibility || '—'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : rightTab === 'combo' ? (
                <div className="p-4 space-y-3">
                  <div className="text-[10px] text-slate-500">
                    Items sharing the same attribute footprint.
                  </div>
                  <details className="group">
                    <summary className="text-[9px] font-bold text-slate-400 uppercase tracking-wider cursor-pointer select-none hover:text-slate-600">Footprint Contents</summary>
                    <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
                      {footprintContent.targetAttrs.length > 0 && <div><span className="text-[8px] font-black uppercase text-slate-400 mr-1">Target Attrs <span className="text-slate-300">({footprintContent.targetAttrs.length})</span></span><span className="flex flex-wrap gap-0.5 mt-0.5">{footprintContent.targetAttrs.map(a => <span key={a} className="px-1 py-0.5 rounded bg-blue-50 text-blue-700 text-[8px] font-medium">{a}</span>)}</span></div>}
                      {footprintContent.legacyFeatures.length > 0 && <div><span className="text-[8px] font-black uppercase text-slate-400 mr-1">Legacy Features <span className="text-slate-300">({footprintContent.legacyFeatures.length})</span></span><span className="flex flex-wrap gap-0.5 mt-0.5">{footprintContent.legacyFeatures.map(f => <span key={f} className="px-1 py-0.5 rounded bg-purple-50 text-purple-700 text-[8px] font-medium">{f}</span>)}</span></div>}
                      {footprintContent.targetValues.length > 0 && <div><span className="text-[8px] font-black uppercase text-slate-400 mr-1">Target Values <span className="text-slate-300">({footprintContent.targetValues.length})</span></span><span className="flex flex-wrap gap-0.5 mt-0.5">{footprintContent.targetValues.map(v => <span key={v} className="px-1 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[8px] font-medium">{v}</span>)}</span></div>}
                      {footprintContent.legacyValues.length > 0 && <div><span className="text-[8px] font-black uppercase text-slate-400 mr-1">Legacy Values <span className="text-slate-300">({footprintContent.legacyValues.length})</span></span><span className="flex flex-wrap gap-0.5 mt-0.5">{footprintContent.legacyValues.map(v => <span key={v} className="px-1 py-0.5 rounded bg-amber-50 text-amber-700 text-[8px] font-medium">{v}</span>)}</span></div>}
                    </div>
                  </details>
                  {mergedDetail.comboItems.length === 0 ? (
                    <div className="py-8 text-sm text-slate-400 text-center">No combo items found.</div>
                  ) : (() => {
                    const ps = 50;
                    const items = mergedDetail.comboItems;
                    const totalPages = Math.ceil(items.length / ps);
                    const sliced = items.slice(comboPage * ps, (comboPage + 1) * ps);
                    return (
                      <div className="space-y-1">
                        {sliced.map((ci) => (
                          <div key={ci.itemId} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-sky-50 border border-sky-100">
                            <span className="text-[11px] font-bold text-sky-800">{ci.itemId}</span>
                            <span className="text-[10px] text-slate-500 truncate">{ci.description || '—'}</span>
                          </div>
                        ))}
                        {totalPages > 1 && (
                          <div className="flex items-center justify-between pt-2">
                            <button disabled={comboPage === 0} onClick={() => setComboPage(p => p - 1)} className="px-2 py-1 text-[10px] font-bold rounded bg-slate-100 text-slate-600 disabled:opacity-30">← Prev</button>
                            <span className="text-[10px] text-slate-400">Page {comboPage + 1} of {totalPages} ({items.length} items)</span>
                            <button disabled={comboPage >= totalPages - 1} onClick={() => setComboPage(p => p + 1)} className="px-2 py-1 text-[10px] font-bold rounded bg-slate-100 text-slate-600 disabled:opacity-30">Next →</button>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ) : rightTab === 'sharedvl' ? (
                <div className="p-4 space-y-3">
                  <div className="text-[10px] text-slate-500">
                    Attributes where other items share the same value list.
                  </div>
                  <details className="group">
                    <summary className="text-[9px] font-bold text-slate-400 uppercase tracking-wider cursor-pointer select-none hover:text-slate-600">Footprint Contents</summary>
                    <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
                      {footprintContent.targetAttrs.length > 0 && <div><span className="text-[8px] font-black uppercase text-slate-400 mr-1">Target Attrs <span className="text-slate-300">({footprintContent.targetAttrs.length})</span></span><span className="flex flex-wrap gap-0.5 mt-0.5">{footprintContent.targetAttrs.map(a => <span key={a} className="px-1 py-0.5 rounded bg-blue-50 text-blue-700 text-[8px] font-medium">{a}</span>)}</span></div>}
                      {footprintContent.targetValues.length > 0 && <div><span className="text-[8px] font-black uppercase text-slate-400 mr-1">Target Values <span className="text-slate-300">({footprintContent.targetValues.length})</span></span><span className="flex flex-wrap gap-0.5 mt-0.5">{footprintContent.targetValues.map(v => <span key={v} className="px-1 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[8px] font-medium">{v}</span>)}</span></div>}
                    </div>
                  </details>
                  {mergedDetail.sharedVL.length === 0 ? (
                    <div className="py-8 text-sm text-slate-400 text-center">No shared value lists found.</div>
                  ) : (
                    <div className="space-y-3">
                      {mergedDetail.sharedVL.map((sv) => (
                        <div key={sv.attribute} className="rounded-lg border border-teal-200 bg-teal-50/30 p-3">
                          <div className="flex items-center justify-between gap-2 mb-2">
                            <span className="text-[11px] font-black text-teal-800">{sv.attribute}</span>
                            <span className="text-[9px] text-slate-400 font-bold">{sv.totalShared} item{sv.totalShared !== 1 ? 's' : ''}</span>
                          </div>
                          <div className="flex flex-wrap gap-1 mb-2">
                            {sv.values.slice(0, 10).map((v) => (
                              <span key={v} className="px-1.5 py-0.5 rounded bg-teal-100 text-teal-700 text-[9px] font-medium">{v}</span>
                            ))}
                            {sv.values.length > 10 ? <span className="text-[9px] text-slate-400">+{sv.values.length - 10} more</span> : null}
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {sv.sharedItems.slice(0, 8).map((si) => (
                              <span key={si} className="px-1.5 py-0.5 rounded bg-white border border-teal-200 text-slate-700 text-[9px] font-medium">{si}</span>
                            ))}
                            {sv.sharedItems.length > 8 ? <span className="text-[9px] text-slate-400">+{sv.sharedItems.length - 8} more</span> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : rightTab === 'legacycombo' ? (
                <div className="p-4 space-y-3">
                  <div className="text-[10px] text-slate-500">
                    Items sharing the same legacy feature footprint.
                  </div>
                  <details className="group">
                    <summary className="text-[9px] font-bold text-slate-400 uppercase tracking-wider cursor-pointer select-none hover:text-slate-600">Footprint Contents</summary>
                    <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
                      {footprintContent.legacyFeatures.length > 0 && <div><span className="text-[8px] font-black uppercase text-slate-400 mr-1">Legacy Features <span className="text-slate-300">({footprintContent.legacyFeatures.length})</span></span><span className="flex flex-wrap gap-0.5 mt-0.5">{footprintContent.legacyFeatures.map(f => <span key={f} className="px-1 py-0.5 rounded bg-purple-50 text-purple-700 text-[8px] font-medium">{f}</span>)}</span></div>}
                      {footprintContent.targetAttrs.length > 0 && <div><span className="text-[8px] font-black uppercase text-slate-400 mr-1">Target Attrs <span className="text-slate-300">({footprintContent.targetAttrs.length})</span></span><span className="flex flex-wrap gap-0.5 mt-0.5">{footprintContent.targetAttrs.map(a => <span key={a} className="px-1 py-0.5 rounded bg-blue-50 text-blue-700 text-[8px] font-medium">{a}</span>)}</span></div>}
                      {footprintContent.legacyValues.length > 0 && <div><span className="text-[8px] font-black uppercase text-slate-400 mr-1">Legacy Values <span className="text-slate-300">({footprintContent.legacyValues.length})</span></span><span className="flex flex-wrap gap-0.5 mt-0.5">{footprintContent.legacyValues.map(v => <span key={v} className="px-1 py-0.5 rounded bg-amber-50 text-amber-700 text-[8px] font-medium">{v}</span>)}</span></div>}
                    </div>
                  </details>
                  {(mergedDetail.legacyComboItems?.length ?? 0) === 0 ? (
                    <div className="py-8 text-sm text-slate-400 text-center">No legacy combo items found.</div>
                  ) : (() => {
                    const ps = 50;
                    const items = mergedDetail.legacyComboItems ?? [];
                    const totalPages = Math.ceil(items.length / ps);
                    const sliced = items.slice(legacyComboPage * ps, (legacyComboPage + 1) * ps);
                    return (
                      <div className="space-y-1">
                        {sliced.map((ci) => (
                          <div key={ci.itemId} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-50 border border-purple-100">
                            <span className="text-[11px] font-bold text-purple-800">{ci.itemId}</span>
                            <span className="text-[10px] text-slate-500 truncate">{ci.description || '—'}</span>
                          </div>
                        ))}
                        {totalPages > 1 && (
                          <div className="flex items-center justify-between pt-2">
                            <button disabled={legacyComboPage === 0} onClick={() => setLegacyComboPage(p => p - 1)} className="px-2 py-1 text-[10px] font-bold rounded bg-slate-100 text-slate-600 disabled:opacity-30">← Prev</button>
                            <span className="text-[10px] text-slate-400">Page {legacyComboPage + 1} of {totalPages} ({items.length} items)</span>
                            <button disabled={legacyComboPage >= totalPages - 1} onClick={() => setLegacyComboPage(p => p + 1)} className="px-2 py-1 text-[10px] font-bold rounded bg-slate-100 text-slate-600 disabled:opacity-30">Next →</button>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ) : rightTab === 'legacysharedvl' ? (
                <div className="p-4 space-y-3">
                  <div className="text-[10px] text-slate-500">
                    Legacy features where other items share the same value list.
                  </div>
                  <details className="group">
                    <summary className="text-[9px] font-bold text-slate-400 uppercase tracking-wider cursor-pointer select-none hover:text-slate-600">Footprint Contents</summary>
                    <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
                      {footprintContent.legacyFeatures.length > 0 && <div><span className="text-[8px] font-black uppercase text-slate-400 mr-1">Legacy Features <span className="text-slate-300">({footprintContent.legacyFeatures.length})</span></span><span className="flex flex-wrap gap-0.5 mt-0.5">{footprintContent.legacyFeatures.map(f => <span key={f} className="px-1 py-0.5 rounded bg-purple-50 text-purple-700 text-[8px] font-medium">{f}</span>)}</span></div>}
                      {footprintContent.legacyValues.length > 0 && <div><span className="text-[8px] font-black uppercase text-slate-400 mr-1">Legacy Values <span className="text-slate-300">({footprintContent.legacyValues.length})</span></span><span className="flex flex-wrap gap-0.5 mt-0.5">{footprintContent.legacyValues.map(v => <span key={v} className="px-1 py-0.5 rounded bg-amber-50 text-amber-700 text-[8px] font-medium">{v}</span>)}</span></div>}
                    </div>
                  </details>
                  {(mergedDetail.legacySharedVL?.length ?? 0) === 0 ? (
                    <div className="py-8 text-sm text-slate-400 text-center">No legacy shared value lists found.</div>
                  ) : (
                    <div className="space-y-3">
                      {(mergedDetail.legacySharedVL ?? []).map((sv) => (
                        <div key={sv.feature} className="rounded-lg border border-fuchsia-200 bg-fuchsia-50/30 p-3">
                          <div className="flex items-center justify-between gap-2 mb-2">
                            <span className="text-[11px] font-black text-fuchsia-800">{sv.feature}</span>
                            <span className="text-[9px] text-slate-400 font-bold">{sv.totalShared} item{sv.totalShared !== 1 ? 's' : ''}</span>
                          </div>
                          <div className="flex flex-wrap gap-1 mb-2">
                            {sv.values.slice(0, 10).map((v) => (
                              <span key={v} className="px-1.5 py-0.5 rounded bg-fuchsia-100 text-fuchsia-700 text-[9px] font-medium">{v}</span>
                            ))}
                            {sv.values.length > 10 ? <span className="text-[9px] text-slate-400">+{sv.values.length - 10} more</span> : null}
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {sv.sharedItems.slice(0, 8).map((si) => (
                              <span key={si} className="px-1.5 py-0.5 rounded bg-white border border-fuchsia-200 text-slate-700 text-[9px] font-medium">{si}</span>
                            ))}
                            {sv.sharedItems.length > 8 ? <span className="text-[9px] text-slate-400">+{sv.sharedItems.length - 8} more</span> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 text-[10px] text-slate-500 shrink-0">
              {mergedDetail ? `${mergedDetail.totalMappings} mapping${mergedDetail.totalMappings !== 1 ? 's' : ''}` : '0 mappings'}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default MigrationManifest;