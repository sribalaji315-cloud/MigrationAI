
import React, { useState, useEffect, useRef } from 'react';
import BOMHeader from './components/BOMHeader';
import ItemSidebar from './components/ItemSidebar';
import MappingWorkspace from './components/MappingWorkspace';
import DataInspector from './components/DataInspector';
import LoginSignUp from './components/LoginSignUp';
import { dbService } from './services/dbService';
import { GlobalMapping, DataCategory, DatabaseState, User, ConnectionMode, LocalItemMappings } from './types';

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('CONNECTING');
  
  const [dbState, setDbState] = useState<DatabaseState | null>(null);
  const [activeInspector, setActiveInspector] = useState<DataCategory | null>(null);
  
  const pollingRef = useRef<number | null>(null);

  // when the inspector is open we temporarily pause background polling
  useEffect(() => {
    handleFetchFromDB();
    // clear existing interval if any
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    pollingRef.current = window.setInterval(() => {
      // skip fetching while someone is editing management console
      if (!activeInspector) {
        handleFetchFromDB();
      }
    }, 5000); // Polling SQL is heavier, slowed down to 5s

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [activeInspector]);

  const handleFetchFromDB = async () => {
    try {
      const { state, mode } = await dbService.fetchAll();
      setDbState(state);
      setConnectionMode(mode);
    } catch (error) {
      console.error("Database sync failed", error);
      setConnectionMode('LOCAL_MOCK');
    }
  };

  const handleLogin = (user: User) => {
    setCurrentUser(user);
    handleFetchFromDB();
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setSelectedItemId(null);
  };

  const handleSignOn = async (itemId: string) => {
    if (!currentUser) return;
    setIsRefreshing(true);
    const success = await dbService.acquireLock(itemId, currentUser.userId, currentUser.userName);
    if (!success) {
      alert("This item is currently locked by another session.");
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
  }) => {
    if (!dbState) return;
    setIsRefreshing(true);
    
    const nextState: DatabaseState = {
      ...dbState,
      localMappings: { ...dbState.localMappings, ...updates.localMappings },
      itemClassifications: { ...dbState.itemClassifications, ...updates.itemClassifications },
      mappings: updates.globalMappings || dbState.mappings
    };

    const newMode = await dbService.saveAll(nextState);
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

  const handleSaveInspectorData = async (category: DataCategory, updatedData: any) => {
    if (!dbState) return;
    let nextState = { ...dbState };

    if (category === 'mapping') nextState.mappings = updatedData;
    if (category === 'classification' || category === 'values') nextState.classifications = updatedData;
    if (category === 'bom') nextState.bom = updatedData;
    if (category === 'users') nextState.users = updatedData;

    const newMode = await dbService.saveAll(nextState);
    setConnectionMode(newMode);
    setDbState(nextState);
    setActiveInspector(null);
  };

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

  const selectedItem = dbState.bom.find(item => item.itemId === selectedItemId) || null;
  const currentLock = selectedItemId ? dbState.locks[selectedItemId] : null;
  const isLockedByMe = currentLock?.userId === currentUser.userId;

  return (
    <div className="flex flex-col h-screen bg-slate-50 overflow-hidden font-sans antialiased">
      <BOMHeader 
        onRegenerate={handleFetchFromDB} 
        isRefreshing={isRefreshing} 
        onInspectData={setActiveInspector}
        onCommit={handleCommit}
        currentUser={currentUser}
        onLogout={handleLogout}
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
          items={dbState.bom} 
          selectedId={selectedItemId} 
          onSelect={setSelectedItemId} 
          locks={dbState.locks}
          currentUserId={currentUser.userId}
        />
        
        <MappingWorkspace 
          item={selectedItem}
          classes={dbState.classifications}
          globalMappings={dbState.mappings}
          localItemMappings={dbState.localMappings}
          assignedClassId={selectedItemId ? dbState.itemClassifications[selectedItemId] : null}
          isLockedByMe={isLockedByMe}
          lockOwner={currentLock}
          onSignOn={() => selectedItemId && handleSignOn(selectedItemId)}
          onSignOff={() => selectedItemId && handleSignOff(selectedItemId)}
          onSaveChanges={handleSaveWorkspaceChanges}
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
