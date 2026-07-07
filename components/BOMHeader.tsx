
import React, { useState, useEffect, useRef } from 'react';
import { DataCategory, User, MappingGenerationProgress, ApplyGroupFeatureProgress, MLSettings } from '../types';
import { dbService } from '../services/dbService';

interface BOMHeaderProps {
  onRegenerate: () => void;
  isRefreshing: boolean;
  onInspectData: (category: DataCategory) => void;
  onCommit: () => void;
  currentUser: User;
  onLogout: () => void;
  onClearCache: () => void;
  onExportBomCsv: () => void;
  onOpenDashboard: () => void;
  onOpenHierarchy: () => void;
  onOpenFeatureCombinations: () => void;
  onOpenAttributeCombinations: () => void;
  onOpenMigrationManifest: () => void;
  onOpenGroupFeatures: () => void;
  onOpenProductViewer: () => void;
  mappingGenerationProgress?: MappingGenerationProgress | null;
  onRetriggerGeneration?: () => void;
  onRevertAllToGlobal?: () => void;
  isMappingGenerationActive?: boolean;
  applyGroupFeatureProgress?: ApplyGroupFeatureProgress | null;
  onApplyGroupFeatures?: () => void;
  isApplyGroupFeatureActive?: boolean;
  onPredictAll?: () => void;
  mlPredictionProgress?: { status: string; progress: number; total: number; processed: number } | null;
}

const BOMHeader: React.FC<BOMHeaderProps> = ({ onRegenerate, isRefreshing, onInspectData, onCommit, currentUser, onLogout, onClearCache, onExportBomCsv, onOpenDashboard, onOpenHierarchy, onOpenFeatureCombinations, onOpenAttributeCombinations, onOpenMigrationManifest, onOpenGroupFeatures, onOpenProductViewer, mappingGenerationProgress, onRetriggerGeneration, onRevertAllToGlobal, isMappingGenerationActive, applyGroupFeatureProgress, onApplyGroupFeatures, isApplyGroupFeatureActive, onPredictAll, mlPredictionProgress }) => {
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

  const [isSwingFeasibilityImporting, setIsSwingFeasibilityImporting] = useState(false);
  const handleImportSwingFeasibility = async () => {
    if (currentUser.role !== 'admin') return;
    if (isSwingFeasibilityImporting) return;
    if (!confirm('This will update workspace mapping feasibility and condition values from the configured SwingExpansionValues SQLite table. Continue?')) return;

    try {
      setIsSwingFeasibilityImporting(true);
      const result = await dbService.importSwingFeasibility(false);
      alert(`Swing feasibility import finished.\n\n${result.summary || 'No summary returned.'}`);
      onRegenerate();
    } catch (err: any) {
      alert(`Failed to import swing feasibility data: ${err?.message || String(err)}`);
    } finally {
      setIsSwingFeasibilityImporting(false);
    }
  };

  // ML settings popover
  const [mlSettingsOpen, setMlSettingsOpen] = useState(false);
  const [mlSettings, setMlSettings] = useState<MLSettings>({ useSynonymAssist: true, synonymThreshold: 0.5, synonymWeight: 0.35 });
  const [mlSettingsDirty, setMlSettingsDirty] = useState(false);
  const mlPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mlSettingsOpen && currentUser.role === 'admin') {
      dbService.getMLSettings().then(setMlSettings).catch(() => {});
    }
  }, [mlSettingsOpen]);

  useEffect(() => {
    if (!mlSettingsOpen) return;
    const handler = (e: MouseEvent) => {
      if (mlPopoverRef.current && !mlPopoverRef.current.contains(e.target as Node)) setMlSettingsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [mlSettingsOpen]);

  const saveMLSettings = async (patch: Partial<MLSettings>) => {
    try {
      const updated = await dbService.updateMLSettings(patch);
      setMlSettings(updated);
      setMlSettingsDirty(false);
    } catch { /* ignore */ }
  };

  const generationPercent = Math.round(((mappingGenerationProgress?.progress || 0) * 100));
  const generationStatus = mappingGenerationProgress?.status || 'idle';
  const generationTone = generationStatus === 'failed'
    ? 'bg-rose-50 border-rose-200 text-rose-700'
    : generationStatus === 'completed'
      ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
      : generationStatus === 'running' || generationStatus === 'queued'
        ? 'bg-amber-50 border-amber-200 text-amber-700'
        : 'bg-slate-50 border-slate-200 text-slate-500';

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
              {mappingGenerationProgress && generationStatus !== 'idle' && (
                <div className={`ml-2 inline-flex items-center gap-1 px-2 py-0.5 border rounded-full text-[8px] font-black uppercase tracking-widest ${generationTone}`}>
                  <span>Mapping Gen</span>
                  <span>{generationStatus === 'running' || generationStatus === 'queued' ? `${generationPercent}%` : generationStatus}</span>
                </div>
              )}
              {currentUser.role === 'admin' && onRetriggerGeneration && (
                <button
                  type="button"
                  onClick={onRetriggerGeneration}
                  disabled={isMappingGenerationActive}
                  className={`ml-1 inline-flex items-center gap-1 px-2 py-0.5 border rounded-full text-[8px] font-black uppercase tracking-widest transition-colors ${
                    isMappingGenerationActive
                      ? 'bg-slate-50 border-slate-200 text-slate-300 cursor-not-allowed'
                      : 'bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100'
                  }`}
                  title="Re-generate workspace mappings from current BOM and global mappings"
                >
                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Regenerate
                </button>
              )}
              {currentUser.role === 'admin' && onRevertAllToGlobal && (
                <button
                  type="button"
                  onClick={onRevertAllToGlobal}
                  disabled={isMappingGenerationActive}
                  className={`ml-1 inline-flex items-center gap-1 px-2 py-0.5 border rounded-full text-[8px] font-black uppercase tracking-widest transition-colors ${
                    isMappingGenerationActive
                      ? 'bg-slate-50 border-slate-200 text-slate-300 cursor-not-allowed'
                      : 'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100'
                  }`}
                  title="Delete all local overrides and regenerate everything from global mappings"
                >
                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                  </svg>
                  Revert All to Global
                </button>
              )}
              {applyGroupFeatureProgress && applyGroupFeatureProgress.status !== 'idle' && isApplyGroupFeatureActive && (
                <div className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 border rounded-full text-[8px] font-black uppercase tracking-widest bg-teal-50 border-teal-200 text-teal-700">
                  <span>Group Apply</span>
                  <span>{Math.round((applyGroupFeatureProgress.progress || 0) * 100)}%</span>
                </div>
              )}
              {currentUser.role === 'admin' && onApplyGroupFeatures && (
                <button
                  type="button"
                  onClick={onApplyGroupFeatures}
                  disabled={isApplyGroupFeatureActive || isMappingGenerationActive}
                  className={`ml-1 inline-flex items-center gap-1 px-2 py-0.5 border rounded-full text-[8px] font-black uppercase tracking-widest transition-colors ${
                    isApplyGroupFeatureActive || isMappingGenerationActive
                      ? 'bg-slate-50 border-slate-200 text-slate-300 cursor-not-allowed'
                      : 'bg-teal-50 border-teal-200 text-teal-700 hover:bg-teal-100'
                  }`}
                  title="Apply group feature mappings onto workspace mappings (intersection of group feature + sub-feature present in the item)"
                >
                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-3.13a4 4 0 10-4 0M12 4a4 4 0 014 4" />
                  </svg>
                  {isApplyGroupFeatureActive ? 'Applying…' : 'Apply Group Feature'}
                </button>
              )}
              {currentUser.role === 'admin' && onPredictAll && (
                <div className="relative inline-flex items-center">
                <button
                  type="button"
                  onClick={onPredictAll}
                  disabled={mlPredictionProgress?.status === 'running' || mlPredictionProgress?.status === 'queued'}
                  className={`ml-1 inline-flex items-center gap-1 px-2 py-0.5 border rounded-l-full text-[8px] font-black uppercase tracking-widest transition-colors ${
                    mlPredictionProgress?.status === 'running' || mlPredictionProgress?.status === 'queued'
                      ? 'bg-slate-50 border-slate-200 text-slate-300 cursor-not-allowed'
                      : 'bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100'
                  }`}
                  title="Run ML classification prediction on all BOM items"
                >
                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                  ML Predict All
                </button>
                <button
                  type="button"
                  onClick={() => setMlSettingsOpen(!mlSettingsOpen)}
                  className={`inline-flex items-center px-1.5 py-0.5 border border-l-0 rounded-r-full text-[8px] transition-colors ${
                    mlSettingsOpen
                      ? 'bg-violet-100 border-violet-300 text-violet-800'
                      : 'bg-violet-50 border-violet-200 text-violet-500 hover:bg-violet-100'
                  }`}
                  title="ML prediction settings"
                >
                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
                {mlSettingsOpen && (
                  <div ref={mlPopoverRef} className="absolute top-full left-0 mt-1 z-50 bg-white border border-violet-200 rounded-lg shadow-lg p-3 w-64">
                    <div className="text-[9px] font-black text-violet-700 uppercase tracking-widest mb-2">ML Prediction Settings</div>
                    <label className="flex items-center gap-2 mb-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={mlSettings.useSynonymAssist}
                        onChange={e => saveMLSettings({ useSynonymAssist: e.target.checked })}
                        className="accent-violet-600 w-3 h-3"
                      />
                      <span className="text-[10px] font-bold text-slate-700">Synonym Assist</span>
                    </label>
                    <div className="mb-2">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[9px] font-bold text-slate-500 uppercase">Threshold</span>
                        <span className="text-[9px] font-black text-violet-700 tabular-nums">{mlSettings.synonymThreshold.toFixed(2)}</span>
                      </div>
                      <input
                        type="range" min="0" max="1" step="0.05"
                        value={mlSettings.synonymThreshold}
                        onChange={e => { setMlSettings(s => ({ ...s, synonymThreshold: parseFloat(e.target.value) })); setMlSettingsDirty(true); }}
                        onMouseUp={() => mlSettingsDirty && saveMLSettings({ synonymThreshold: mlSettings.synonymThreshold })}
                        onTouchEnd={() => mlSettingsDirty && saveMLSettings({ synonymThreshold: mlSettings.synonymThreshold })}
                        className="w-full h-1 bg-violet-100 rounded-full appearance-none cursor-pointer accent-violet-600"
                        disabled={!mlSettings.useSynonymAssist}
                      />
                      <div className="flex justify-between text-[8px] text-slate-400"><span>Lenient</span><span>Strict</span></div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[9px] font-bold text-slate-500 uppercase">Weight</span>
                        <span className="text-[9px] font-black text-violet-700 tabular-nums">{mlSettings.synonymWeight.toFixed(2)}</span>
                      </div>
                      <input
                        type="range" min="0" max="1" step="0.05"
                        value={mlSettings.synonymWeight}
                        onChange={e => { setMlSettings(s => ({ ...s, synonymWeight: parseFloat(e.target.value) })); setMlSettingsDirty(true); }}
                        onMouseUp={() => mlSettingsDirty && saveMLSettings({ synonymWeight: mlSettings.synonymWeight })}
                        onTouchEnd={() => mlSettingsDirty && saveMLSettings({ synonymWeight: mlSettings.synonymWeight })}
                        className="w-full h-1 bg-violet-100 rounded-full appearance-none cursor-pointer accent-violet-600"
                        disabled={!mlSettings.useSynonymAssist}
                      />
                      <div className="flex justify-between text-[8px] text-slate-400"><span>Model Only</span><span>Synonym Only</span></div>
                    </div>
                  </div>
                )}
                </div>
              )}
              {mlPredictionProgress && (mlPredictionProgress.status === 'running' || mlPredictionProgress.status === 'queued' || mlPredictionProgress.status === 'completed' || mlPredictionProgress.status === 'failed') && (
                <div className={`ml-2 inline-flex items-center gap-1 px-2 py-0.5 border rounded-full text-[8px] font-black uppercase tracking-widest ${
                  mlPredictionProgress.status === 'failed'
                    ? 'bg-rose-50 border-rose-200 text-rose-700'
                    : mlPredictionProgress.status === 'completed'
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                      : 'bg-violet-50 border-violet-200 text-violet-700'
                }`}>
                  <span>ML Predict</span>
                  <span>{mlPredictionProgress.status === 'running' || mlPredictionProgress.status === 'queued' ? `${Math.round(mlPredictionProgress.progress * 100)}%` : mlPredictionProgress.status}</span>
                </div>
              )}
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
            onClick={() => window.location.reload()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border bg-white text-blue-600 border-blue-200 hover:bg-blue-50 hover:border-blue-300 transition-all"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

      <div className="bg-slate-50/50 backdrop-blur-md px-5 py-2 flex items-center gap-6 border-t border-slate-100">
        <div className="flex items-center gap-1.5 flex-shrink-0">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500"></div>
            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">MGMT:</span>
        </div>
        <div className="flex gap-1.5 flex-wrap">
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
          <div className="h-6 w-px bg-slate-200 mx-1"></div>
          <button
            type="button"
            onClick={onOpenGroupFeatures}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-50 text-amber-700 border border-amber-100 hover:bg-amber-100 rounded-md text-[9px] font-black transition-all whitespace-nowrap uppercase tracking-wider"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            Group Features
          </button>
          <button
            type="button"
            onClick={onOpenProductViewer}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-sky-50 text-sky-700 border border-sky-100 hover:bg-sky-100 rounded-md text-[9px] font-black transition-all whitespace-nowrap uppercase tracking-wider"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            Product Viewer
          </button>
          {currentUser.role === 'admin' && (
            <>
              <div className="h-6 w-px bg-slate-200 mx-1"></div>
                  <button 
                    type="button"
                    onClick={onOpenDashboard}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-indigo-50 text-indigo-700 border border-indigo-100 hover:bg-indigo-100 rounded-md text-[9px] font-black transition-all whitespace-nowrap uppercase tracking-wider"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
                    </svg>
                    Mapping Dashboard
                  </button>

                  <button 
                    type="button"
                    onClick={onOpenHierarchy}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-violet-50 text-violet-700 border border-violet-100 hover:bg-violet-100 rounded-md text-[9px] font-black transition-all whitespace-nowrap uppercase tracking-wider"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                    </svg>
                    BOM Hierarchy
                  </button>

                  <button 
                    type="button"
                    onClick={onOpenFeatureCombinations}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-teal-50 text-teal-700 border border-teal-100 hover:bg-teal-100 rounded-md text-[9px] font-black transition-all whitespace-nowrap uppercase tracking-wider"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                    Feature Combos
                  </button>

                  <button 
                    type="button"
                    onClick={onOpenAttributeCombinations}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-sky-50 text-sky-700 border border-sky-100 hover:bg-sky-100 rounded-md text-[9px] font-black transition-all whitespace-nowrap uppercase tracking-wider"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                    </svg>
                    Attribute Combos
                  </button>

                  <button 
                    type="button"
                    onClick={onOpenMigrationManifest}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-indigo-50 text-indigo-700 border border-indigo-100 hover:bg-indigo-100 rounded-md text-[9px] font-black transition-all whitespace-nowrap uppercase tracking-wider"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6M7 4h7l5 5v11a2 2 0 01-2 2H7a2 2 0 01-2-2V6a2 2 0 012-2z" />
                    </svg>
                    Migration Manifest
                  </button>

                  <button
                    type="button"
                    onClick={handleImportSwingFeasibility}
                    disabled={isSwingFeasibilityImporting}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 border rounded-md text-[9px] font-black transition-all whitespace-nowrap uppercase tracking-wider ${
                      isSwingFeasibilityImporting
                        ? 'bg-slate-50 text-slate-300 border-slate-200 cursor-not-allowed'
                        : 'bg-amber-50 text-amber-700 border-amber-100 hover:bg-amber-100'
                    }`}
                    title="Import feasibility and condition from SwingExpansionValues"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    {isSwingFeasibilityImporting ? 'Importing...' : 'Import Feasibility'}
                  </button>

                  <button 
                    type="button"
                    onClick={onExportBomCsv}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-100 hover:bg-emerald-100 rounded-md text-[9px] font-black transition-all whitespace-nowrap uppercase tracking-wider"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    Export BOM CSV
                  </button>

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
