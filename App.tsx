
import React, { useState, useEffect, useRef, useMemo, useCallback, Suspense, lazy } from 'react';
import BOMHeader from './components/BOMHeader';
import ItemSidebar from './components/ItemSidebar';
import LoginSignUp from './components/LoginSignUp';
import { dbService } from './services/dbService';
import { GlobalMapping, DataCategory, DatabaseState, User, ConnectionMode, LocalItemMappings, FeatureFlags, MappingTypeConfig, MappingGenerationProgress, ApplyGroupFeatureProgress, WorkspaceMappingRow } from './types';
import { useBomPagination } from './hooks/useBomPagination';
import { useLocking } from './hooks/useLocking';
import { useItemStatusTracking } from './hooks/useItemStatusTracking';
import { useWebSocket, WsEvent } from './hooks/useWebSocket';

const MappingWorkspace = lazy(() => import('./components/MappingWorkspace'));
const DataInspector = lazy(() => import('./components/DataInspector'));
const MappingDashboard = lazy(() => import('./components/MappingDashboard'));
const BOMHierarchy = lazy(() => import('./components/BOMHierarchy'));
const FeatureCombinations = lazy(() => import('./components/FeatureCombinations'));
const AttributeCombinations = lazy(() => import('./components/AttributeCombinations'));
const MigrationManifest = lazy(() => import('./components/MigrationManifest'));
const GroupFeatures = lazy(() => import('./components/GroupFeatures'));
const ProductViewer = lazy(() => import('./components/ProductViewer'));

const LazyFallback = () => (
  <div className="flex items-center justify-center p-8">
    <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
  </div>
);

const SectionSpinner = ({ label }: { label: string }) => (
  <div className="flex flex-col items-center justify-center h-full w-full gap-3 py-16">
    <div className="w-6 h-6 border-[2.5px] border-blue-600 border-t-transparent rounded-full animate-spin" />
    <p className="text-slate-400 text-[9px] font-black uppercase tracking-widest">{label}</p>
  </div>
);

const EMPTY_DB_STATE: DatabaseState = {
  bom: [],
  mappings: [],
  classifications: [],
  localMappings: {},
  itemClassifications: {},
  locks: {},
  users: [],
};

type ItemStatus = 'mapped' | 'unmapped' | 'notRequired';
type SidebarBomFilters = { category?: string; productType?: string; userId?: string; priority?: number; unmappedOnly?: boolean };

const normalizeMappingType = (value?: string | null) => (value || '').trim().toLowerCase();

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('CONNECTING');
  
  const [dbState, setDbState] = useState<DatabaseState | null>(null);
  const [activeInspector, setActiveInspector] = useState<DataCategory | null>(null);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showHierarchy, setShowHierarchy] = useState(false);
  const [showFeatureCombinations, setShowFeatureCombinations] = useState(false);
  const [showAttributeCombinations, setShowAttributeCombinations] = useState(false);
  const [showMigrationManifest, setShowMigrationManifest] = useState(false);
  const [showGroupFeatures, setShowGroupFeatures] = useState(false);
  const [showProductViewer, setShowProductViewer] = useState(false);
  const [showUnmappedOnlyInSidebar, setShowUnmappedOnlyInSidebar] = useState(false);
  const [featureFlags, setFeatureFlags] = useState<FeatureFlags>(() => ({
    useNewClassTargetMapping: import.meta.env.VITE_USE_NEW_CLASS_TARGET_MAPPING === 'true',
  }));
  const [mappingGenerationProgress, setMappingGenerationProgress] = useState<MappingGenerationProgress | null>(null);
  const [applyGroupFeatureProgress, setApplyGroupFeatureProgress] = useState<ApplyGroupFeatureProgress | null>(null);
  const [mlPredictionProgress, setMlPredictionProgress] = useState<{ status: string; progress: number; total: number; processed: number } | null>(null);
  const [mappingTotalCount, setMappingTotalCount] = useState(0);
  const [classificationTotalCount, setClassificationTotalCount] = useState(0);
  const [isDataLoading, setIsDataLoading] = useState(false);

  const {
    bomPage,
    setBomPage,
    bomTotalCount,
    setBomTotalCount,
    bomFilters,
    setBomFilters,
    handleFetchBomItems,
    BOM_PAGE_SIZE,
  } = useBomPagination(dbState, currentUser, setDbState, setIsRefreshing);

  const { itemStatuses, setItemStatuses, visibleBomItems, sidebarItems, includedMappingTypes } =
    useItemStatusTracking(dbState, currentUser, showUnmappedOnlyInSidebar);

  // --- Sidebar server search state ---
  const [sidebarSearchResults, setSidebarSearchResults] = useState<DatabaseState['bom'] | null>(null);
  const [sidebarSearchTotal, setSidebarSearchTotal] = useState<number>(0);
  const [sidebarAdminFilters, setSidebarAdminFilters] = useState<SidebarBomFilters>({});
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState('');
  const [sidebarTotalCount, setSidebarTotalCount] = useState<number>(0);
  const [sidebarBomItems, setSidebarBomItems] = useState<DatabaseState['bom']>([]);
  const sidebarSearchGenRef = useRef(0);
  const sidebarLoadGenRef = useRef(0);

  const refreshItemStatuses = useCallback(async () => {
    try {
      const statuses = await dbService.fetchItemStatuses();
      setItemStatuses(statuses);
    } catch (err) {
      console.warn('Failed to refresh item statuses', err);
    }
  }, [setItemStatuses]);

  const loadSidebarItems = useCallback(async (filters: SidebarBomFilters = {}, page = 0, search = '') => {
    if (!currentUser) return;
    const isAdmin = currentUser.role === 'admin';
    const gen = ++sidebarLoadGenRef.current;
    setIsDataLoading(true);
    setSidebarAdminFilters(filters);
    setSidebarSearchQuery(search);
    setBomPage(page);
    try {
      const [result, totalCount] = await Promise.all([
        dbService.fetchSignedOnBomItems({
          category: filters.category,
          productType: filters.productType,
          userId: filters.userId,
          search: search || undefined,
          priority: filters.priority,
          unmappedOnly: filters.unmappedOnly,
          limit: BOM_PAGE_SIZE,
          offset: page * BOM_PAGE_SIZE,
        }),
        dbService.fetchBomCount(
          filters.category,
          filters.productType,
          search || undefined,
          filters.priority,
          filters.unmappedOnly,
          !isAdmin,  // excludeOtherLocks for non-admin users
        ),
      ]);
      if (gen !== sidebarLoadGenRef.current) return;
      setSidebarBomItems(result.items);
      setSidebarTotalCount(totalCount);
      setSidebarSearchResults(null);
      setSidebarSearchTotal(0);
      await refreshItemStatuses();
    } catch (err) {
      if (gen !== sidebarLoadGenRef.current) return;
      console.warn('Failed to fetch filtered BOM items', err);
    } finally {
      if (gen === sidebarLoadGenRef.current) {
        setIsDataLoading(false);
      }
    }
  }, [BOM_PAGE_SIZE, currentUser, refreshItemStatuses, setBomPage]);

  const handleSidebarSearch = useCallback(async (query: string, filters: SidebarBomFilters = sidebarAdminFilters) => {
    const mergedFilters = { ...filters, unmappedOnly: showUnmappedOnlyInSidebar || undefined };
    await loadSidebarItems(mergedFilters, 0, query.trim());
  }, [loadSidebarItems, sidebarAdminFilters, showUnmappedOnlyInSidebar]);

  const handleAdminFilterChange = useCallback(async (filters: SidebarBomFilters) => {
    await loadSidebarItems({ ...filters, unmappedOnly: showUnmappedOnlyInSidebar || undefined }, 0, sidebarSearchQuery);
  }, [loadSidebarItems, sidebarSearchQuery, showUnmappedOnlyInSidebar]);

  const handleAdminSidebarPageChange = useCallback(async (page: number) => {
    await loadSidebarItems({ ...sidebarAdminFilters, unmappedOnly: showUnmappedOnlyInSidebar || undefined }, page, sidebarSearchQuery);
  }, [loadSidebarItems, sidebarAdminFilters, sidebarSearchQuery, showUnmappedOnlyInSidebar]);

  // WebSocket: real-time collaboration events (ref avoids stale closure)
  const fetchFromDBRef = useRef<() => void>(() => {});
  const handleWsEvent = useCallback((event: WsEvent) => {
    if (event.type === 'lock_change' || event.type === 'data_sync') {
      fetchFromDBRef.current();
    } else if (event.type === 'approval_change') {
      fetchFromDBRef.current();
    } else if (event.type === 'generation_progress') {
      if (event.payload?.status === 'completed') {
        fetchFromDBRef.current();
      }
    } else if (event.type === 'ml_prediction_progress') {
      const p = event.payload;
      if (p) {
        setMlPredictionProgress({ status: p.status, progress: p.progress ?? 0, total: p.total ?? 0, processed: p.processed ?? 0 });
        if (p.status === 'completed') {
          fetchFromDBRef.current();
        }
      }
    }
  }, []);
  useWebSocket(currentUser?.userId ?? null, handleWsEvent);

  // --- Lazy-load workspace mappings for selected item ---
  const localMappingsGenRef = useRef(0);
  useEffect(() => {
    if (!selectedItemId || !dbState) return;
    // Already loaded for this item
    if (dbState.localMappings[selectedItemId]) return;
    const gen = ++localMappingsGenRef.current;
    dbService.fetchWorkspaceMappings(selectedItemId).then((rows: WorkspaceMappingRow[]) => {
      if (gen !== localMappingsGenRef.current) return;
      // Convert flat rows into GlobalMapping[] grouped by (featureId, newAttributeId)
      const grouped: Record<string, GlobalMapping> = {};
      for (const row of rows) {
        const key = `${row.legacyFeatureId}||${row.newAttributeId}`;
        let m = grouped[key];
        if (!m) {
          m = {
            legacyFeatureIds: [row.legacyFeatureId],
            newAttributeId: row.newAttributeId,
            attributeType: row.attributeType || '',
            mappedFrom: (row.mappedFrom as GlobalMapping['mappedFrom']) || 'global',
            valueMappings: {},
            valueMeta: {},
          };
          grouped[key] = m;
        }
        if (row.legacyValue !== '' || row.newValue !== '') {
          m.valueMappings[row.legacyValue] = row.newValue;
        }
        if (!m.valueMeta) m.valueMeta = {};
        m.valueMeta[row.legacyValue] = {
          condition: row.condition ?? null,
          feasibility: row.feasibility ?? null,
          valueStatus: row.valueStatus ?? null,
        };
      }
      setDbState(prev => prev ? {
        ...prev,
        localMappings: { ...prev.localMappings, [selectedItemId]: Object.values(grouped) },
      } : prev);
    }).catch(err => {
      console.warn('Failed to fetch workspace mappings for', selectedItemId, err);
    });
  }, [selectedItemId, dbState?.localMappings]);

  // Initial load: restore session from token if present, then fetch DB state.
  useEffect(() => {
    const token = localStorage.getItem('erp_migrator_token');
    if (token) {
      dbService.me().then((remoteUser: any) => {
        const user: User = {
          userId: `USR-${remoteUser.id}`,
          userName: remoteUser.username,
          password: '',
          role: remoteUser.role,
        };
        setCurrentUser(user);
        setDbState(prev => prev || EMPTY_DB_STATE);
        handleFetchFromDB(user);
      }).catch(() => {
        // Token expired/invalid — fall through to login screen
        localStorage.removeItem('erp_migrator_token');
        setConnectionMode('REMOTE_SQL');
      });
    } else {
      // No token — just show login screen, don't try to fetch protected data
      setConnectionMode('REMOTE_SQL');
    }
  }, []);

  const handleFetchFromDB = async (user?: User | null) => {
    setIsDataLoading(true);
    try {
      // Step 1: Lightweight init — locks, users, config only (<200ms)
      const init = await dbService.fetchInit();

      // Step 2: Fire ALL secondary fetches in parallel
      const [bomResult, totalCount, statuses, mappingResult, classResult, filters] = await Promise.all([
        dbService.fetchSignedOnBomItems({ limit: 20, offset: 0 }).catch(err => { console.warn('Failed to fetch signed-on BOM items', err); return { items: [] as DatabaseState['bom'], signedOnCount: 0, totalCount: 0 }; }),
        dbService.fetchBomCount().catch(err => { console.warn('Failed to fetch BOM count', err); return 0; }),
        dbService.fetchItemStatuses().catch(err => { console.warn('Failed to fetch item statuses', err); return {} as Record<string, 'mapped' | 'unmapped' | 'notRequired'>; }),
        dbService.fetchGlobalMappingsPaginated({ limit: 20, offset: 0 }).catch(err => { console.warn('Failed to fetch mappings', err); return { items: [] as GlobalMapping[], total: 0 }; }),
        dbService.fetchClassificationsPaginated({ limit: 20, offset: 0 }).catch(err => { console.warn('Failed to fetch classifications', err); return { items: [] as any[], total: 0 }; }),
        dbService.fetchBomFilters().catch(err => { console.warn('Failed to fetch BOM filters', err); return { categories: [] as string[], productTypes: [] as string[], priorities: [] as number[] }; }),
      ]);

      setDbState({
        bom: bomResult.items,
        mappings: 'items' in mappingResult ? mappingResult.items : [],
        classifications: 'items' in classResult ? classResult.items : [],
        mappingTypeConfig: init.mappingTypeConfig,
        localMappings: {},
        itemClassifications: init.itemClassifications || {},
        locks: init.locks || {},
        users: init.users || [],
      });
      setBomTotalCount(totalCount);
      setSidebarBomItems(bomResult.items);
      setSidebarTotalCount(totalCount);
      setItemStatuses(statuses);
      setMappingTotalCount('total' in mappingResult ? mappingResult.total : 0);
      setClassificationTotalCount('total' in classResult ? classResult.total : 0);
      setConnectionMode('REMOTE_SQL');
      setBomFilters(filters);
    } catch (error: any) {
      console.error("Database sync failed", error);
      alert(`Failed to connect to database: ${error?.message || 'Unknown error'}. Please ensure the backend server is running on port 8000.`);
      setConnectionMode('LOCAL_MOCK');
      setDbState(null);
    } finally {
      setIsDataLoading(false);
    }
  };
  fetchFromDBRef.current = () => handleFetchFromDB();

  const handleLogin = (user: User) => {
    setCurrentUser(user);
    setDbState(prev => prev || EMPTY_DB_STATE);
    handleFetchFromDB(user);
  };

  const handleLogout = () => {
      dbService.logout();
    setSelectedItemId(null);
    setMappingGenerationProgress(null);
  };

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const pollProgress = async () => {
      if (document.hidden) {
        timer = setTimeout(pollProgress, 30000);
        return;
      }
      try {
        const progress = await dbService.fetchMappingGenerationProgress();
        if (!cancelled) {
          setMappingGenerationProgress(progress);
        }
        const isActive = progress.status === 'queued' || progress.status === 'running';
        const waitMs = isActive ? 2000 : 10000;
        if (!cancelled) {
          timer = setTimeout(pollProgress, waitMs);
        }
      } catch {
        if (!cancelled) {
          timer = setTimeout(pollProgress, 10000);
        }
      }
    };

    const handleVisibilityChange = () => {
      if (!document.hidden && !cancelled) {
        if (timer) clearTimeout(timer);
        pollProgress();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    pollProgress();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const pollProgress = async () => {
      if (document.hidden) {
        timer = setTimeout(pollProgress, 30000);
        return;
      }
      try {
        const progress = await dbService.fetchApplyGroupFeatureProgress();
        if (!cancelled) {
          setApplyGroupFeatureProgress(progress);
        }
        const isActive = progress.status === 'queued' || progress.status === 'running';
        const waitMs = isActive ? 2000 : 15000;
        if (!cancelled) {
          timer = setTimeout(pollProgress, waitMs);
        }
      } catch {
        if (!cancelled) {
          timer = setTimeout(pollProgress, 15000);
        }
      }
    };

    const handleVisibilityChange = () => {
      if (!document.hidden && !cancelled) {
        if (timer) clearTimeout(timer);
        pollProgress();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    pollProgress();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentUser]);

  const handleSaveWorkspaceChanges = async (updates: {
    localMappings?: LocalItemMappings;
    itemClassifications?: Record<string, string>;
    globalMappings?: GlobalMapping[];
  }) => {
    if (!dbState) return;
    setIsRefreshing(true);
    
    const nextState: DatabaseState = {
      ...dbState,
      localMappings: { ...dbState.localMappings, ...updates.localMappings },
      itemClassifications: { ...dbState.itemClassifications, ...updates.itemClassifications },
      mappings: updates.globalMappings || dbState.mappings,
    };

    // Never send the partial session BOM, classifications, or mappings to the sync endpoint —
    // doing so would create duplicate global mapping rows from the paginated subset.
    // BOM is managed via DataInspector CSV upload; classifications via their own bulk endpoint;
    // global mappings via the DataInspector mapping tab.
    const { bom: _bom, classifications: _cls, mappings: _mappings, ...stateWithoutBom } = nextState as any;
    const saveResult = await dbService.saveAll(stateWithoutBom as DatabaseState, currentUser?.role);
    setConnectionMode(saveResult.mode);
    // Invalidate cached localMappings for saved items so the useEffect
    // re-fetches from the backend (which now has auto-populated values).
    const savedItemIds = Object.keys(updates.localMappings || {});
    const refreshedLocalMappings = { ...nextState.localMappings };
    savedItemIds.forEach(id => { delete refreshedLocalMappings[id]; });
    setDbState({ ...nextState, localMappings: refreshedLocalMappings });
    setIsRefreshing(false);
    setShowSuccess(true);
    setTimeout(() => setShowSuccess(false), 3000);
  };

  const handleRevertItemToGlobal = async (itemId: string) => {
    // Targeted refresh: invalidate cached local mappings for reverted item
    // so the useEffect re-fetches from backend. Don't reset pagination.
    setDbState(prev => {
      if (!prev) return prev;
      const updated = { ...prev.localMappings };
      delete updated[itemId];
      return { ...prev, localMappings: updated };
    });
    await refreshItemStatuses();
  };

  const handleCommit = async () => {
    setIsRefreshing(true);
    await handleFetchFromDB();
    setIsRefreshing(false);
    setShowSuccess(true);
    setTimeout(() => setShowSuccess(false), 3000);
  };

  const handleClearCache = async () => {
    if (confirm('Clear auth token and reload from database?')) {
      localStorage.removeItem('erp_migrator_token');
      window.location.reload();
    }
  };

  const handleSaveInspectorData = async (
    category: DataCategory,
    updatedData: any,
    options?: { closeInspector?: boolean; source?: 'manual' | 'auto' }
  ) => {
    if (!dbState) return;
    const nextState = { ...dbState };

    // Extract the edited-only mappings for the sync payload BEFORE touching
    // nextState.  The in-memory app state must keep its full list so the UI
    // doesn't lose data; only the sync payload should carry the delta.
    let editedMappingsForSync: any[] | undefined;

    if (category === 'mapping') {
      if (Array.isArray(updatedData)) {
        editedMappingsForSync = updatedData;
        // Do NOT overwrite nextState.mappings – keep the full cached list.
      } else {
        editedMappingsForSync = updatedData?.mappings || [];
        nextState.mappingTypeConfig = updatedData?.mappingTypeConfig;
        // Do NOT overwrite nextState.mappings – keep the full cached list.
      }
    }

    if (category === 'classification' || category === 'values') {
      nextState.classifications = updatedData;
    }

    if (category === 'bom') {
      nextState.bom = updatedData;
    }

    if (category === 'users') {
      nextState.users = updatedData;
    }

    // Build a reduced payload for sync so we never overwrite full tables
    // with paginated UI subsets.
    const syncPayload: any = { ...nextState };

    // For mappings, send ONLY the edited records – never the full cached list.
    if (category === 'mapping') {
      syncPayload.mappings = editedMappingsForSync;
      syncPayload.mappingSyncMode = 'patch';
      syncPayload.deletedGlobalMappingIds = Array.isArray(updatedData?.deletedGlobalMappingIds)
        ? updatedData.deletedGlobalMappingIds
        : [];
      syncPayload.deletedGlobalMappingKeys = Array.isArray(updatedData?.deletedGlobalMappingKeys)
        ? updatedData.deletedGlobalMappingKeys
        : [];
    } else {
      delete syncPayload.mappings;
      delete syncPayload.mappingSyncMode;
      delete syncPayload.deletedGlobalMappingIds;
      delete syncPayload.deletedGlobalMappingKeys;
    }

    if (category !== 'classification' && category !== 'values') {
      delete syncPayload.classifications;
    }

    if (category !== 'bom') {
      delete syncPayload.bom;
    }

    // DataInspector does not edit workspace mappings directly.
    delete syncPayload.localMappings;

    const saveResult = await dbService.saveAll(syncPayload as DatabaseState, currentUser?.role);
    setConnectionMode(saveResult.mode);

    if (category === 'bom' && saveResult.mappingGenerationJobId) {
      setMappingGenerationProgress(prev => ({
        id: saveResult.mappingGenerationJobId,
        status: 'queued',
        isActive: true,
        progress: 0,
        totalFeatures: prev?.totalFeatures || 0,
        processedFeatures: 0,
        totalValues: prev?.totalValues || 0,
        processedValues: 0,
        generatedRows: 0,
        triggeredByUserId: prev?.triggeredByUserId || currentUser?.userId || null,
        triggeredByUsername: prev?.triggeredByUsername || currentUser?.userName || null,
        startedAt: prev?.startedAt || null,
        finishedAt: null,
        updatedAt: Date.now(),
        error: null,
      }));
    }

    setDbState(nextState);
    if (options?.closeInspector !== false) {
      setActiveInspector(null);
    }
  };

  const isMappingGenerationActive =
    mappingGenerationProgress?.status === 'queued' || mappingGenerationProgress?.status === 'running';

  const handleRetriggerGeneration = async () => {
    try {
      const result = await dbService.triggerMappingGeneration();
      if (result.mappingGenerationJobId) {
        setMappingGenerationProgress(prev => ({
          id: result.mappingGenerationJobId,
          status: 'queued',
          isActive: true,
          progress: 0,
          totalFeatures: prev?.totalFeatures || 0,
          processedFeatures: 0,
          totalValues: prev?.totalValues || 0,
          processedValues: 0,
          generatedRows: 0,
          triggeredByUserId: currentUser?.userId || null,
          triggeredByUsername: currentUser?.userName || null,
          startedAt: null,
          finishedAt: null,
          updatedAt: Date.now(),
          error: null,
        }));
      }
    } catch (err: any) {
      alert(`Failed to trigger generation: ${err?.message || String(err)}`);
    }
  };

  const handleRevertAllToGlobal = async () => {
    if (!confirm('Delete ALL local overrides and regenerate everything from global mappings? This cannot be undone.')) return;
    try {
      const result = await dbService.revertAllToGlobal();
      if (result.mappingGenerationJobId) {
        setMappingGenerationProgress(prev => ({
          id: result.mappingGenerationJobId,
          status: 'queued',
          isActive: true,
          progress: 0,
          totalFeatures: prev?.totalFeatures || 0,
          processedFeatures: 0,
          totalValues: prev?.totalValues || 0,
          processedValues: 0,
          generatedRows: 0,
          triggeredByUserId: currentUser?.userId || null,
          triggeredByUsername: currentUser?.userName || null,
          startedAt: null,
          finishedAt: null,
          updatedAt: Date.now(),
          error: null,
        }));
      }
    } catch (err: any) {
      alert(`Failed to revert all to global: ${err?.message || String(err)}`);
    }
  };

  const isApplyGroupFeatureActive =
    applyGroupFeatureProgress?.status === 'queued' || applyGroupFeatureProgress?.status === 'running';

  const handleApplyGroupFeatures = async () => {
    if (!confirm('Apply group feature mappings onto workspace mappings? This refreshes all group-sourced rows from the current group features.')) return;
    try {
      const result = await dbService.triggerApplyGroupFeatures();
      if (result.jobId) {
        setApplyGroupFeatureProgress(prev => ({
          id: result.jobId ?? undefined,
          status: 'queued',
          isActive: true,
          progress: 0,
          totalFeatures: prev?.totalFeatures || 0,
          processedFeatures: 0,
          generatedRows: 0,
          startedAt: null,
          finishedAt: null,
          error: null,
        }));
      }
    } catch (err: any) {
      alert(`Failed to apply group features: ${err?.message || String(err)}`);
    }
  };

  const handlePredictAll = async () => {
    if (!confirm('Run ML classification prediction on all BOM items? This may take a while.')) return;
    try {
      const result = await dbService.predictAllClassifications();
      setMlPredictionProgress({ status: result.status, progress: result.progress, total: result.total, processed: result.processed });
      // Poll for progress
      const pollInterval = setInterval(async () => {
        try {
          const status = await dbService.getPredictAllStatus();
          setMlPredictionProgress({ status: status.status, progress: status.progress, total: status.total, processed: status.processed });
          if (status.status === 'completed' || status.status === 'failed' || status.status === 'idle') {
            clearInterval(pollInterval);
            if (status.status === 'completed') {
              handleFetchFromDB();
            }
          }
        } catch {
          clearInterval(pollInterval);
        }
      }, 3000);
    } catch (err: any) {
      alert(`Failed to start ML prediction: ${err?.message || String(err)}`);
    }
  };

  // Wire useLocking hook
  const updateLocksAndStatuses = useCallback(async (itemId: string) => {
    try {
      // Lightweight: fetch only init (locks) and status for the affected item
      const [init, partialStatuses] = await Promise.all([
        dbService.fetchInit(),
        dbService.fetchItemStatuses([itemId]),
      ]);
      setDbState(prev => prev ? { ...prev, locks: init.locks || {}, itemClassifications: init.itemClassifications || prev.itemClassifications } : prev);
      setItemStatuses(prev => ({ ...prev, ...partialStatuses }));
    } catch (err) {
      console.warn('Lightweight lock refresh failed, falling back to full fetch', err);
      await handleFetchFromDB();
    }
  }, [handleFetchFromDB, setItemStatuses]);

  const { handleSignOn, handleSignOff } = useLocking(dbState, currentUser, setIsRefreshing, handleFetchFromDB, updateLocksAndStatuses);

  // All users use server-paginated sidebar items
  const effectiveSidebarItems = sidebarBomItems;

  // --- Session transition guards: preserve sidebar state across sign-on / sign-off ---
  const sessionTransitionRef = useRef(false);
  const preSessionSidebarRef = useRef<{
    items: DatabaseState['bom'];
    totalCount: number;
    filters: SidebarBomFilters;
    searchQuery: string;
    page: number;
  } | null>(null);

  const handleSignOnWithSidebar = useCallback(async (itemId: string) => {
    preSessionSidebarRef.current = {
      items: [...sidebarBomItems],
      totalCount: sidebarTotalCount,
      filters: { ...sidebarAdminFilters },
      searchQuery: sidebarSearchQuery,
      page: bomPage,
    };
    sessionTransitionRef.current = true;
    await handleSignOn(itemId);
    // Keep the sidebar list intact so the selected card stays in position
    sessionTransitionRef.current = false;
  }, [handleSignOn, currentUser, sidebarBomItems, sidebarTotalCount, sidebarAdminFilters, sidebarSearchQuery, bomPage]);

  const handleSignOffWithSidebar = useCallback(async (itemId: string) => {
    sessionTransitionRef.current = true;
    await handleSignOff(itemId);
    const saved = preSessionSidebarRef.current;
    if (saved) {
      await loadSidebarItems(
        { ...saved.filters, unmappedOnly: showUnmappedOnlyInSidebar || undefined },
        saved.page,
        saved.searchQuery,
      );
    }
    preSessionSidebarRef.current = null;
    sessionTransitionRef.current = false;
  }, [handleSignOff, currentUser, loadSidebarItems, showUnmappedOnlyInSidebar]);

  useEffect(() => {
    if (sessionTransitionRef.current) return;
    if (selectedItemId && !effectiveSidebarItems.some(item => item.itemId === selectedItemId)) {
      setSelectedItemId(null);
    }
  }, [selectedItemId, effectiveSidebarItems]);

  const selectedItem = effectiveSidebarItems.find(item => item.itemId === selectedItemId) || null;

  if (!currentUser) {
    return <LoginSignUp onLogin={handleLogin} />;
  }

  if (!dbState) return (
    <div className="h-screen bg-slate-900 flex items-center justify-center">
       <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-[3px] border-blue-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest">Initialising SQL Bridge...</p>
       </div>
    </div>
  );

  const currentLock = selectedItemId ? dbState.locks[selectedItemId] : null;
  const isLockedByMe = currentLock?.userId === currentUser.userId;

  const handleToggleNewClassTargetMapping = (forceValue?: boolean) => {
    setFeatureFlags(prev => ({
      ...prev,
      useNewClassTargetMapping: forceValue !== undefined ? forceValue : !prev.useNewClassTargetMapping,
    }));
  };

  const handleExportBomCsv = async () => {
    const blob = await dbService.exportBomCsv();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bom_export_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 overflow-hidden font-sans antialiased">
      <BOMHeader 
        onRegenerate={handleFetchFromDB} 
        isRefreshing={isRefreshing} 
        onInspectData={setActiveInspector}
        onCommit={handleCommit}
        currentUser={currentUser}
        onLogout={handleLogout}
        onClearCache={handleClearCache}
        onExportBomCsv={handleExportBomCsv}
        onOpenDashboard={() => {
          setShowDashboard(true);
        }}
        onOpenHierarchy={() => {
          setShowHierarchy(true);
        }}
        onOpenFeatureCombinations={() => {
          setShowFeatureCombinations(true);
        }}
        onOpenAttributeCombinations={() => {
          setShowAttributeCombinations(true);
        }}
        onOpenMigrationManifest={() => {
          setShowMigrationManifest(true);
        }}
        onOpenGroupFeatures={() => {
          setShowGroupFeatures(true);
        }}
        onOpenProductViewer={() => {
          setShowProductViewer(true);
        }}
        mappingGenerationProgress={mappingGenerationProgress}
        onRetriggerGeneration={handleRetriggerGeneration}
        onRevertAllToGlobal={handleRevertAllToGlobal}
        isMappingGenerationActive={isMappingGenerationActive}
        applyGroupFeatureProgress={applyGroupFeatureProgress}
        onApplyGroupFeatures={handleApplyGroupFeatures}
        isApplyGroupFeatureActive={isApplyGroupFeatureActive}
        onPredictAll={handlePredictAll}
        mlPredictionProgress={mlPredictionProgress}
      />
      
      <main className="flex flex-1 overflow-hidden relative">
        {showSuccess && (
          <div className="fixed top-24 right-6 z-[100] animate-in slide-in-from-right duration-300">
            <div className="bg-green-600 text-white px-4 py-2.5 rounded-lg shadow-xl flex items-center gap-2.5 border border-green-500/50">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
              <span className="font-black text-[10px] uppercase tracking-widest">
                {connectionMode === 'REMOTE_SQL' ? 'SQL COMMIT SUCCESS' : 'LOCAL CACHE SYNCED'}
              </span>
            </div>
          </div>
        )}

        <ItemSidebar 
          items={sidebarBomItems} 
          selectedId={selectedItemId} 
          onSelect={setSelectedItemId} 
          locks={dbState.locks}
          currentUserId={currentUser.userId}
          itemStatuses={itemStatuses}
          showUnmappedOnly={showUnmappedOnlyInSidebar}
          onToggleUnmappedOnly={() => {
            const next = !showUnmappedOnlyInSidebar;
            setShowUnmappedOnlyInSidebar(next);
            loadSidebarItems({ ...sidebarAdminFilters, unmappedOnly: next || undefined }, 0, sidebarSearchQuery);
          }}
          totalServerCount={sidebarTotalCount}
          currentPage={bomPage}
          onPageChange={handleAdminSidebarPageChange}
          onSearch={handleSidebarSearch}
          searchResults={sidebarSearchResults}
          searchTotalCount={sidebarSearchTotal}
          isLoading={isDataLoading}
          isAdmin={currentUser.role === 'admin'}
          categories={bomFilters.categories}
          productTypes={bomFilters.productTypes}
          priorities={bomFilters.priorities}
          allUsers={dbState.users?.map(u => ({ userId: u.userId, userName: u.userName })) || []}
          onFilterChange={handleAdminFilterChange}
        />
        
        <Suspense fallback={<LazyFallback />}>
          {isDataLoading && !selectedItem ? (
            <div className="flex-1 flex items-center justify-center">
              <SectionSpinner label="Loading workspace..." />
            </div>
          ) : (
          <MappingWorkspace 
            item={selectedItem}
            classes={dbState.classifications}
            globalMappings={dbState.mappings}
            mappingTypeConfig={dbState.mappingTypeConfig}
            localItemMappings={dbState.localMappings}
            assignedClassId={selectedItemId ? dbState.itemClassifications[selectedItemId] : null}
            isLockedByMe={isLockedByMe}
            lockOwner={currentLock}
            currentUser={currentUser}
            featureFlags={featureFlags}
            onToggleNewClassTargetMapping={handleToggleNewClassTargetMapping}
            onSignOn={async () => selectedItemId && (await handleSignOnWithSidebar(selectedItemId))}
            onSignOff={async () => selectedItemId && (await handleSignOffWithSidebar(selectedItemId))}
            onSaveChanges={handleSaveWorkspaceChanges}
            onSyncFromDB={handleFetchFromDB}
            onRevertItem={handleRevertItemToGlobal}
            isGenerationActive={isMappingGenerationActive}
          />
          )}
        </Suspense>

        {activeInspector && (
          <Suspense fallback={<LazyFallback />}>
            <DataInspector 
              category={activeInspector}
              onClose={() => setActiveInspector(null)}
              data={{
                mapping: dbState.mappings,
                classification: dbState.classifications,
                values: dbState.classifications,
                bom: dbState.bom,
                users: dbState.users
              }}
              mappingTypeConfig={dbState.mappingTypeConfig}
              onSave={handleSaveInspectorData}
              onSwitchUser={(user) => {
                 setCurrentUser(user);
                 setActiveInspector(null);
              }}
              currentUser={currentUser!}
              bomFilters={bomFilters}
              onFetchBomItems={handleFetchBomItems}
              locks={dbState.locks}
              mappingGenerationProgress={mappingGenerationProgress}
              mappingTotalCount={mappingTotalCount}
              classificationTotalCount={classificationTotalCount}
              bomTotalCount={bomTotalCount}
              onCountsChanged={(counts) => {
                if (counts.mappingTotal != null) setMappingTotalCount(counts.mappingTotal);
                if (counts.classificationTotal != null) setClassificationTotalCount(counts.classificationTotal);
                if (counts.bomTotal != null) setBomTotalCount(counts.bomTotal);
              }}
            />
          </Suspense>
        )}

        <div className={showDashboard ? '' : 'hidden'}>
          <Suspense fallback={<LazyFallback />}>
            <MappingDashboard
              categories={bomFilters.categories || []}
              productLines={bomFilters.productTypes || []}
              priorities={bomFilters.priorities || []}
              onClose={() => {
                setShowDashboard(false);
              }}
            />
          </Suspense>
        </div>

        {showHierarchy && (
          <Suspense fallback={<LazyFallback />}>
            <BOMHierarchy
              currentUser={currentUser}
              onClose={() => setShowHierarchy(false)}
            />
          </Suspense>
        )}

        {showFeatureCombinations && (
          <Suspense fallback={<LazyFallback />}>
            <FeatureCombinations
              currentUser={currentUser}
              onClose={() => setShowFeatureCombinations(false)}
            />
          </Suspense>
        )}

        {showAttributeCombinations && (
          <Suspense fallback={<LazyFallback />}>
            <AttributeCombinations
              currentUser={currentUser}
              onClose={() => setShowAttributeCombinations(false)}
            />
          </Suspense>
        )}

        {showMigrationManifest && (
          <Suspense fallback={<LazyFallback />}>
            <MigrationManifest
              currentUser={currentUser}
              onClose={() => setShowMigrationManifest(false)}
            />
          </Suspense>
        )}

        {showGroupFeatures && (
          <Suspense fallback={<LazyFallback />}>
            <GroupFeatures
              currentUser={currentUser}
              onClose={() => setShowGroupFeatures(false)}
            />
          </Suspense>
        )}

        {showProductViewer && (
          <Suspense fallback={<LazyFallback />}>
            <ProductViewer
              currentUser={currentUser}
              onClose={() => setShowProductViewer(false)}
            />
          </Suspense>
        )}
      </main>

      <footer className="bg-white border-t border-slate-200 px-5 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${connectionMode === 'REMOTE_SQL' ? 'bg-blue-400' : 'bg-green-400'}`}></span>
              <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${connectionMode === 'REMOTE_SQL' ? 'bg-blue-500' : 'bg-green-500'}`}></span>
            </span>
            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
              Engine: <span className={connectionMode === 'REMOTE_SQL' ? 'text-blue-600' : 'text-green-600'}>
                {connectionMode === 'REMOTE_SQL' ? 'REMOTE SQL SERVER' : 'LOCAL MOCK STORAGE'}
              </span>
            </span>
          </div>
          <div className="h-3 w-px bg-slate-200"></div>
          <div className="flex items-center gap-2">
             <span className="text-[9px] font-black text-blue-600 uppercase tracking-widest">{currentUser.userName}</span>
             <span className="text-[7px] font-black text-white bg-slate-900 px-1.5 py-0.5 rounded-[3px] uppercase">{currentUser.role}</span>
          </div>
        </div>
        <div className="flex items-center gap-4">
           {isRefreshing && <span className="text-[8px] font-black text-slate-400 animate-pulse uppercase">Synchronising Stream...</span>}
           <p className="text-[9px] font-black text-slate-300 uppercase tracking-widest">PLM BRIDGE V2.7.0-SQL-HYBRID</p>
        </div>
      </footer>
    </div>
  );
};

export default App;
