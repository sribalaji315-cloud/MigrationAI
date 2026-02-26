
import React, { useState, useEffect, useRef, useMemo } from 'react';
import BOMHeader from './components/BOMHeader';
import ItemSidebar from './components/ItemSidebar';
import MappingWorkspace from './components/MappingWorkspace';
import DataInspector from './components/DataInspector';
import MappingDashboard from './components/MappingDashboard';
import LoginSignUp from './components/LoginSignUp';
import { dbService } from './services/dbService';
import { GlobalMapping, DataCategory, DatabaseState, User, ConnectionMode, LocalItemMappings, FeatureFlags, ClassAttributeValues } from './types';

type ItemStatus = 'mapped' | 'unmapped' | 'notRequired';

const normalizeAttrId = (id: string) => (id || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('CONNECTING');
  
  const [dbState, setDbState] = useState<DatabaseState | null>(null);
  const [activeInspector, setActiveInspector] = useState<DataCategory | null>(null);
  const [showDashboard, setShowDashboard] = useState(false);
  const [bomFilters, setBomFilters] = useState<{ categories: string[]; productTypes: string[] }>({ categories: [], productTypes: [] });
  const [dashboardSnapshot, setDashboardSnapshot] = useState<{ bom: DatabaseState['bom']; mappings: DatabaseState['mappings']; localMappings: DatabaseState['localMappings'] } | null>(null);
  const [featureFlags, setFeatureFlags] = useState<FeatureFlags>(() => ({
    useNewClassTargetMapping: import.meta.env.VITE_USE_NEW_CLASS_TARGET_MAPPING === 'true',
  }));
  
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
        handleFetchFromDB(user);
      }).catch(() => {
        // Token expired/invalid — fall through to login screen
        localStorage.removeItem('erp_migrator_token');
        handleFetchFromDB();
      });
    } else {
      handleFetchFromDB();
    }
  }, []);

  const handleFetchFromDB = async (user?: User | null) => {
    try {
      const { state, mode } = await dbService.fetchAll({ includeBom: false });
      const activeUser = user ?? currentUser;
      let lockedItems: DatabaseState['bom'] = [];
      if (activeUser) {
        const lockIds = Object.values(state.locks || {})
          .filter(lock => activeUser.role === 'admin' || lock.userId === activeUser.userId)
          .map(lock => lock.itemId)
          .filter(Boolean);

        if (lockIds.length) {
          try {
            lockedItems = await dbService.fetchBomItemsByIds(lockIds);
          } catch (err) {
            console.warn('Failed to fetch locked BOM items', err);
          }
        }
      }

      setDbState(prev => ({
        ...state,
        bom: lockedItems.length ? lockedItems : (prev?.bom || []),
      }));
      setConnectionMode(mode);
      try {
        const filters = await dbService.fetchBomFilters();
        setBomFilters(filters);
      } catch (err) {
        console.warn('Failed to fetch BOM filters', err);
      }
    } catch (error: any) {
      console.error("Database sync failed", error);
      alert(`Failed to connect to database: ${error?.message || 'Unknown error'}. Please ensure the backend server is running on port 8000.`);
      setConnectionMode('LOCAL_MOCK');
      setDbState(null);
    }
  };

  const handleLogin = (user: User) => {
    setCurrentUser(user);
    handleFetchFromDB(user);
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setSelectedItemId(null);
  };

  const handleSignOn = async (itemId: string) => {
    if (!currentUser) return;
    const existingLocks = Object.values(dbState?.locks || {}).filter(lock => lock.userId === currentUser.userId);
    if (existingLocks.length >= 2 && !existingLocks.some(lock => lock.itemId === itemId)) {
      alert('You can only sign on to two items at a time. Please sign off another item first.');
      return;
    }
    setIsRefreshing(true);
    const result = await dbService.acquireLock(itemId, currentUser.userId, currentUser.userName);
    if (!result.acquired) {
      if (result.reason === 'limit') {
        alert('You can only sign on to two items at a time. Please sign off another item first.');
      } else if (result.reason === 'locked') {
        alert('This item is currently locked by another session.');
      } else {
        alert('Failed to sign on. Please try again.');
      }
    }
    await handleFetchFromDB();
    setIsRefreshing(false);
  };

  const handleSignOff = async (itemId: string) => {
    if (!currentUser) return;
    setIsRefreshing(true);
    
    if (currentUser.role === 'admin') {
      await dbService.forceReleaseLock(itemId);
    } else {
      await dbService.releaseLock(itemId, currentUser.userId);
    }
    
    await handleFetchFromDB();
    setIsRefreshing(false);
  };

  const handleSaveWorkspaceChanges = async (updates: {
    localMappings?: LocalItemMappings;
    itemClassifications?: Record<string, string>;
    globalMappings?: GlobalMapping[];
    classAttributeValues?: ClassAttributeValues;
  }) => {
    if (!dbState) return;
    setIsRefreshing(true);
    
    const nextState: DatabaseState = {
      ...dbState,
      localMappings: { ...dbState.localMappings, ...updates.localMappings },
      itemClassifications: { ...dbState.itemClassifications, ...updates.itemClassifications },
      mappings: updates.globalMappings || dbState.mappings,
      classAttributeValues: {
        ...(dbState.classAttributeValues || {}),
        ...(updates.classAttributeValues || {}),
      },
    };

    // Never send the partial session BOM (only signed-on items) to the sync endpoint —
    // doing so would wipe every other item from the database.  BOM is managed exclusively
    // through the DataInspector CSV upload / Synchronize flow.
    const { bom: _bom, ...stateWithoutBom } = nextState as any;
    const newMode = await dbService.saveAll(stateWithoutBom as DatabaseState, currentUser?.role);
    setConnectionMode(newMode);
    setDbState(nextState);
    setIsRefreshing(false);
    setShowSuccess(true);
    setTimeout(() => setShowSuccess(false), 3000);
  };

  const handleCommit = async () => {
    setIsRefreshing(true);
    await handleFetchFromDB();
    setIsRefreshing(false);
    setShowSuccess(true);
    setTimeout(() => setShowSuccess(false), 3000);
  };

  const handleFetchDashboardSnapshot = async () => {
    try {
      const { state } = await dbService.fetchAll({ includeBom: true });
      setDashboardSnapshot({
        bom: state.bom || [],
        mappings: state.mappings || [],
        localMappings: state.localMappings || {},
      });
    } catch (err) {
      console.warn('Failed to fetch dashboard snapshot', err);
    }
  };

  const handleClearCache = async () => {
    if (confirm('Clear auth token and reload from database?')) {
      localStorage.removeItem('erp_migrator_token');
      window.location.reload();
    }
  };

  const handleSaveInspectorData = async (category: DataCategory, updatedData: any) => {
    if (!dbState) return;
    let nextState = { ...dbState };

    if (category === 'mapping') nextState.mappings = updatedData;
    if (category === 'classification' || category === 'values') nextState.classifications = updatedData;
    if (category === 'bom') nextState.bom = updatedData;
    if (category === 'users') nextState.users = updatedData;

    const newMode = await dbService.saveAll(nextState, currentUser?.role);
    setConnectionMode(newMode);
    setDbState(nextState);
    setActiveInspector(null);
  };

  const handleFetchBomItems = async (category?: string, productType?: string) => {
    if (!dbState) return [];
    setIsRefreshing(true);
    try {
      const pageSize = 500;
      let offset = 0;
      let items: DatabaseState['bom'] = [];

      while (true) {
        const batch = await dbService.fetchBomItems(category, productType, { limit: pageSize, offset });
        items = items.concat(batch);
        if (batch.length < pageSize) break;
        offset += pageSize;
      }

      setDbState(prev => {
        if (!prev) return prev;
        const lockedIds = new Set(
          Object.values(prev.locks || {})
            .filter(lock => !currentUser || currentUser.role === 'admin' || lock.userId === currentUser.userId)
            .map(lock => lock.itemId)
        );

        const lockedItems = prev.bom.filter(item => lockedIds.has(item.itemId));
        const nextById: Record<string, DatabaseState['bom'][number]> = {};
        lockedItems.forEach(item => {
          nextById[item.itemId] = item;
        });
        items.forEach(item => {
          nextById[item.itemId] = item;
        });

        return { ...prev, bom: Object.values(nextById) };
      });
      return items;
    } finally {
      setIsRefreshing(false);
    }
  };

  const visibleBomItems = useMemo(() => {
    if (!dbState || !currentUser) return [] as DatabaseState['bom'];
    const lockedIds = new Set(
      Object.values(dbState.locks || {})
        .filter(lock => currentUser.role === 'admin' || lock.userId === currentUser.userId)
        .map(lock => lock.itemId)
    );
    return (dbState.bom || []).filter(item => lockedIds.has(item.itemId));
  }, [dbState, currentUser]);

  useEffect(() => {
    if (selectedItemId && !visibleBomItems.some(item => item.itemId === selectedItemId)) {
      setSelectedItemId(null);
    }
  }, [selectedItemId, visibleBomItems]);

  const selectedItem = visibleBomItems.find(item => item.itemId === selectedItemId) || null;

  const itemStatuses = useMemo(() => {
    if (!dbState) return {} as Record<string, ItemStatus>;

    const classAttrMap = new Map<string, Set<string>>();
    (dbState.classifications || []).forEach(cls => {
      classAttrMap.set(
        cls.classId,
        new Set((cls.attributes || []).map(attr => normalizeAttrId(attr.attributeId)))
      );
    });

    const globalByFeature = new Map<string, GlobalMapping>();
    (dbState.mappings || []).forEach(mapping => {
      mapping.legacyFeatureIds.forEach(id => {
        globalByFeature.set(id, mapping);
      });
    });

    const localByItem: Record<string, Map<string, GlobalMapping>> = {};
    Object.entries(dbState.localMappings || {}).forEach(([itemId, mappings]) => {
      const featureMap = new Map<string, GlobalMapping>();
      mappings.forEach(map => {
        map.legacyFeatureIds.forEach(id => featureMap.set(id, map));
      });
      localByItem[itemId] = featureMap;
    });

    const statusMap: Record<string, ItemStatus> = {};

    (dbState.bom || []).forEach(item => {
      const classId = (dbState.itemClassifications || {})[item.itemId] || 'UNCLASSIFIED';
      const classKeys = classAttrMap.get(classId) || new Set<string>();
      const localOverrides = localByItem[item.itemId] || new Map<string, GlobalMapping>();

      let hasUnmapped = false;
      let anyMapped = false;
      let allNotRequired = item.features.length > 0;

      item.features.forEach(feature => {
        const localOverride = localOverrides.get(feature.featureId);
        const globalMapping = globalByFeature.get(feature.featureId);

        const collectCandidates = (source?: string | null) => {
          if (!source) return [] as string[];
          return source
            .split(';')
            .map(s => s.trim())
            .filter(Boolean);
        };

        const candidateFromLocal = localOverride &&
          localOverride.newAttributeId &&
          localOverride.newAttributeId !== 'UNMAPPED' &&
          localOverride.newAttributeId !== 'NOT REQUIRED'
            ? localOverride.newAttributeId
            : '';

        const fallbackCandidates = collectCandidates(candidateFromLocal || globalMapping?.newAttributeId || '');

        let selectedAttribute = localOverride?.newAttributeId || (fallbackCandidates[0] || 'UNMAPPED');

        if (featureFlags.useNewClassTargetMapping && classId !== 'UNCLASSIFIED' && classKeys.size > 0) {
          const matched = fallbackCandidates.find(attr => classKeys.has(normalizeAttrId(attr)));
          if (matched) {
            selectedAttribute = matched;
          } else if (
            selectedAttribute &&
            selectedAttribute !== 'UNMAPPED' &&
            selectedAttribute !== 'NOT REQUIRED'
          ) {
            selectedAttribute = 'UNMAPPED';
          }
        }

        const effectiveMapping = localOverride || globalMapping;

        if (selectedAttribute === 'UNMAPPED' || !effectiveMapping) {
          hasUnmapped = true;
          allNotRequired = false;
        } else if (selectedAttribute === 'NOT REQUIRED') {
          // keep yellow state
        } else {
          anyMapped = true;
          allNotRequired = false;
        }

        if (selectedAttribute !== 'UNMAPPED' && selectedAttribute !== 'NOT REQUIRED') {
          feature.values.forEach(val => {
            if (!effectiveMapping?.valueMappings || effectiveMapping.valueMappings[val] == null) {
              hasUnmapped = true;
            }
          });
        }
      });

      let status: ItemStatus;
      if (hasUnmapped) status = 'unmapped';
      else if (!anyMapped && allNotRequired) status = 'notRequired';
      else status = 'mapped';

      statusMap[item.itemId] = status;
    });

    return statusMap;
  }, [dbState, featureFlags.useNewClassTargetMapping]);

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

  const handleToggleNewClassTargetMapping = () => {
    setFeatureFlags(prev => ({
      ...prev,
      useNewClassTargetMapping: !prev.useNewClassTargetMapping,
    }));
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
        onOpenDashboard={() => {
          setShowDashboard(true);
          handleFetchDashboardSnapshot();
        }}
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
          items={visibleBomItems} 
          selectedId={selectedItemId} 
          onSelect={setSelectedItemId} 
          locks={dbState.locks}
          currentUserId={currentUser.userId}
          itemStatuses={itemStatuses}
        />
        
        <MappingWorkspace 
          item={selectedItem}
          classes={dbState.classifications}
          globalMappings={dbState.mappings}
          localItemMappings={dbState.localMappings}
          classAttributeValues={dbState.classAttributeValues || {}}
          assignedClassId={selectedItemId ? dbState.itemClassifications[selectedItemId] : null}
          isLockedByMe={isLockedByMe}
          lockOwner={currentLock}
          currentUser={currentUser}
          featureFlags={featureFlags}
          onToggleNewClassTargetMapping={handleToggleNewClassTargetMapping}
          onSignOn={async () => selectedItemId && (await handleSignOn(selectedItemId))}
          onSignOff={async () => selectedItemId && (await handleSignOff(selectedItemId))}
          onSaveChanges={handleSaveWorkspaceChanges}
          onSyncFromDB={handleFetchFromDB}
        />

        {activeInspector && (
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
            onSave={handleSaveInspectorData}
            onSwitchUser={(user) => {
               setCurrentUser(user);
               setActiveInspector(null);
            }}
            currentUser={currentUser!}
            bomFilters={bomFilters}
            onFetchBomItems={handleFetchBomItems}
            locks={dbState.locks}
            onSignOnItem={handleSignOn}
          />
        )}

        {showDashboard && (
          <MappingDashboard
            bom={dashboardSnapshot?.bom || []}
            mappings={dashboardSnapshot?.mappings || []}
            localMappings={dashboardSnapshot?.localMappings || {}}
            onRecompute={handleFetchDashboardSnapshot}
            onClose={() => {
              setShowDashboard(false);
              setDashboardSnapshot(null);
            }}
          />
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
