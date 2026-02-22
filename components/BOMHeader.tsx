
import React from 'react';
import { DataCategory, User } from '../types';
import { dbService } from '../services/dbService';

interface BOMHeaderProps {
  onRegenerate: () => void;
  isRefreshing: boolean;
  onInspectData: (category: DataCategory) => void;
  onCommit: () => void;
  currentUser: User;
  onLogout: () => void;
  onClearCache: () => void;
}

const BOMHeader: React.FC<BOMHeaderProps> = ({ onRegenerate, isRefreshing, onInspectData, onCommit, currentUser, onLogout, onClearCache }) => {
  const uploadOptions: { label: string; id: DataCategory; icon: string; adminOnly?: boolean }[] = [
    { label: 'Global Mapping', id: 'mapping', icon: 'M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2' },
    { label: 'Classifications', id: 'classification', icon: 'M4 6h16M4 10h16M4 14h16M4 18h16' },
    { label: 'Value Lists', id: 'values', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2' },
    { label: 'BOM Items', id: 'bom', icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10' },
    { label: 'User Registry', id: 'users', icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z', adminOnly: true },
  ];

  const handleResetDB = async () => {
    if (confirm("Are you sure? This will wipe all shared data and revert to system defaults.")) {
      await dbService.resetToDefaults();
      onRegenerate();
    }
  };

  return (
    <div className="flex flex-col border-b border-slate-200 shrink-0 relative z-20">
      <header className="bg-white px-5 py-2.5 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="bg-blue-600 p-1.5 rounded-lg text-white shadow-md">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-black text-slate-900 leading-none tracking-tight">ERP Data Migrator</h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              <p className="text-[9px] text-slate-400 uppercase tracking-widest font-bold">PLM Bridge</p>
              <div className="h-2 w-px bg-slate-200"></div>
              <div className="flex items-center gap-1">
                 <span className={`px-1 rounded-[3px] text-[7px] font-black uppercase ${currentUser.role === 'admin' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                    {currentUser.role}
                 </span>
                 <p className="text-[9px] text-blue-600 font-black uppercase">{currentUser.userName}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button 
            type="button"
            onClick={onLogout}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-black text-slate-400 hover:text-red-500 transition-colors uppercase tracking-widest"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
            Switch ID
          </button>
          
          <div className="h-5 w-px bg-slate-200 mx-1"></div>

          <button 
            type="button"
            onClick={onRegenerate}
            disabled={isRefreshing}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border transition-all ${
              isRefreshing 
                ? 'bg-slate-50 text-slate-400 cursor-not-allowed border-slate-200' 
                : 'bg-white text-blue-600 border-blue-200 hover:bg-blue-50 hover:border-blue-300'
            }`}
          >
            <svg className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Sync
          </button>
          
          <button 
            type="button"
            onClick={onClearCache}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border bg-white text-orange-600 border-orange-200 hover:bg-orange-50 hover:border-orange-300 transition-all"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Reload
          </button>
          
          <button 
            type="button"
            onClick={onCommit}
            className="px-4 py-1.5 text-xs font-black text-white bg-blue-600 rounded-lg hover:bg-blue-700 shadow shadow-blue-100 transition-all active:scale-95 uppercase tracking-wide"
          >
            EXECUTE COMMIT
          </button>
        </div>
      </header>

      <div className="bg-slate-50/50 backdrop-blur-md px-5 py-2 flex items-center gap-6 overflow-x-auto no-scrollbar border-t border-slate-100">
        <div className="flex items-center gap-1.5 flex-shrink-0">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500"></div>
            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">MGMT:</span>
        </div>
        <div className="flex gap-1.5">
            {uploadOptions.filter(opt => !opt.adminOnly || currentUser.role === 'admin').map((opt) => (
            <button 
              type="button"
              key={opt.id}
              onClick={() => onInspectData(opt.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[9px] font-bold transition-all shadow-sm active:scale-95 whitespace-nowrap uppercase tracking-wider ${
                opt.adminOnly 
                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white' 
                  : 'bg-white hover:bg-slate-50 text-slate-700 border border-slate-200'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={opt.icon} />
              </svg>
              {opt.label}
            </button>
          ))}
          {currentUser.role === 'admin' && (
            <>
              <div className="h-6 w-px bg-slate-200 mx-1"></div>
              <button 
                type="button"
                onClick={handleResetDB}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-red-50 text-red-600 border border-red-100 hover:bg-red-100 rounded-md text-[9px] font-black transition-all whitespace-nowrap uppercase tracking-wider"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                WIPE STATE
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default BOMHeader;
