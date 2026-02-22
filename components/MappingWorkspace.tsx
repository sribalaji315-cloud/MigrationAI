
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { LegacyItem, NewClassification, GlobalMapping, LocalItemMappings, NewAttribute, ItemLock } from '../types';

interface MappingWorkspaceProps {
  item: LegacyItem | null;
  classes: NewClassification[];
  globalMappings: GlobalMapping[];
  localItemMappings: LocalItemMappings;
  assignedClassId?: string | null;
  isLockedByMe: boolean;
  lockOwner: ItemLock | null;
  onSignOn: () => void;
  onSignOff: () => void;
  onSaveChanges: (updates: any) => void;
}

const MappingWorkspace: React.FC<MappingWorkspaceProps> = ({ 
  item, 
  classes, 
  globalMappings, 
  localItemMappings, 
  assignedClassId,
  isLockedByMe,
  lockOwner,
  onSignOn,
  onSignOff,
  onSaveChanges
}) => {
  const [manualInputs, setManualInputs] = useState<Record<string, string>>({});
  const [stagedLocalMappings, setStagedLocalMappings] = useState<GlobalMapping[]>([]);
  const [stagedClassId, setStagedClassId] = useState<string | null>(null);
  const isEditingRef = useRef(false);
  const prevItemIdRef = useRef<string | null>(null);

  // Initialize workspace when item changes
  useEffect(() => {
    if (item) {
      const isNewItem = prevItemIdRef.current !== item.itemId;
      if (isNewItem) {
        isEditingRef.current = false;
        prevItemIdRef.current = item.itemId;
      }

      if (!isEditingRef.current || !isLockedByMe) {
        setStagedClassId(assignedClassId || 'UNCLASSIFIED');
        setStagedLocalMappings(JSON.parse(JSON.stringify(localItemMappings[item.itemId] || [])));
        setManualInputs({});
      }
    } else {
      prevItemIdRef.current = null;
    }
  }, [item, assignedClassId, localItemMappings, isLockedByMe]);

  const handleManualInputChange = (key: string, value: string) => {
    if (!isLockedByMe) return;
    isEditingRef.current = true;
    setManualInputs(prev => ({ ...prev, [key]: value }));
  };

  const commitToSystem = () => {
    if (!item) return;
    onSaveChanges({
      localMappings: { [item.itemId]: stagedLocalMappings },
      itemClassifications: { [item.itemId]: stagedClassId || 'UNCLASSIFIED' }
    });
    isEditingRef.current = false;
  };

  const handleDiscardSessionChanges = () => {
    if (!item) return;
    if (confirm("Discard all unsaved changes for this session?")) {
      isEditingRef.current = false;
      setStagedClassId(assignedClassId || 'UNCLASSIFIED');
      setStagedLocalMappings(JSON.parse(JSON.stringify(localItemMappings[item.itemId] || [])));
      setManualInputs({});
    }
  };

  const handleResetToGlobal = (featureId: string) => {
    if (!isLockedByMe) return;
    isEditingRef.current = true;
    setStagedLocalMappings(prev => prev.filter(m => !m.legacyFeatureIds.includes(featureId)));
  };

  const allSystemAttributes = useMemo(() => {
    const attrMap = new Map<string, NewAttribute & { sourceClass?: string }>();
    classes.forEach(c => {
      c.attributes.forEach(a => {
        if (!attrMap.has(a.attributeId)) {
          attrMap.set(a.attributeId, { ...a, sourceClass: c.className });
        }
      });
    });
    return Array.from(attrMap.values());
  }, [classes]);

  const targetAttributes = useMemo(() => {
    const classId = stagedClassId || 'UNCLASSIFIED';
    let attrs: NewAttribute[] = [];
    if (classId === 'UNCLASSIFIED') {
      attrs = [...allSystemAttributes];
    } else {
      const selectedClass = classes.find(c => c.classId === classId);
      attrs = selectedClass ? [...selectedClass.attributes] : [];
    }

    // Ensure global mappings are available in the dropdown
    const attrIds = new Set(attrs.map(a => a.attributeId));
    globalMappings.forEach(m => {
      if (m.newAttributeId && !attrIds.has(m.newAttributeId)) {
        attrs.push({ attributeId: m.newAttributeId, description: 'Global Mapping' });
        attrIds.add(m.newAttributeId);
      }
    });

    // Ensure local mappings are available in the dropdown
    stagedLocalMappings.forEach(m => {
      if (m.newAttributeId && !attrIds.has(m.newAttributeId)) {
        attrs.push({ attributeId: m.newAttributeId, description: 'Local Mapping' });
        attrIds.add(m.newAttributeId);
      }
    });

    return attrs;
  }, [stagedClassId, classes, allSystemAttributes, globalMappings, stagedLocalMappings]);

  const handleUpdateLinkage = (featureId: string, attrId: string) => {
    if (!isLockedByMe) return;
    isEditingRef.current = true;
    setStagedLocalMappings(prev => {
      const filtered = prev.filter(m => !m.legacyFeatureIds.includes(featureId));
      const globalRef = globalMappings.find(m => m.legacyFeatureIds.includes(featureId));
      return [
        ...filtered,
        {
          legacyFeatureIds: [featureId],
          newAttributeId: attrId,
          valueMappings: globalRef ? { ...globalRef.valueMappings } : {}
        }
      ];
    });
  };

  const handleUpdateValue = (featureId: string, legacyVal: string, newVal: string) => {
    if (!isLockedByMe) return;
    isEditingRef.current = true;
    setStagedLocalMappings(prev => {
      const next = [...prev];
      let idx = next.findIndex(m => m.legacyFeatureIds.includes(featureId));
      if (idx === -1) {
        const globalRef = globalMappings.find(m => m.legacyFeatureIds.includes(featureId));
        next.push({
          legacyFeatureIds: [featureId],
          newAttributeId: globalRef?.newAttributeId || '',
          valueMappings: globalRef ? { ...globalRef.valueMappings, [legacyVal]: newVal } : { [legacyVal]: newVal }
        });
      } else {
        const existingMapping = next[idx];
        if (existingMapping.legacyFeatureIds.length > 1) {
          const otherFeatures = existingMapping.legacyFeatureIds.filter(id => id !== featureId);
          next[idx] = { ...existingMapping, legacyFeatureIds: otherFeatures };
          next.push({
            legacyFeatureIds: [featureId],
            newAttributeId: existingMapping.newAttributeId,
            valueMappings: { ...existingMapping.valueMappings, [legacyVal]: newVal }
          });
        } else {
          next[idx] = { ...existingMapping, valueMappings: { ...existingMapping.valueMappings, [legacyVal]: newVal } };
        }
      }
      return next;
    });
  };

  if (!item) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-white m-4 rounded-2xl border border-dashed border-slate-200 text-slate-400">
        <div className="bg-slate-50 p-4 rounded-full mb-4 text-slate-300">
          <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
        </div>
        <h3 className="text-lg font-black text-slate-900 tracking-tight uppercase tracking-wider">Workspace Interface</h3>
        <p className="max-w-xs text-center mt-1 text-[11px] text-slate-500 font-medium">Select a BOM record from the registry to initiate mapping overrides.</p>
      </div>
    );
  }

  const isReadOnly = !isLockedByMe;
  const isDirty = isEditingRef.current;

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-[#F8FAFC]">
      <div className="max-w-6xl mx-auto space-y-4">
        
        {/* Compact Collaboration Banner */}
        <div className={`px-4 py-2.5 rounded-xl flex items-center justify-between border shadow-sm transition-all duration-300 ${
          isLockedByMe 
            ? 'bg-indigo-600 border-indigo-500 text-white' 
            : lockOwner 
              ? 'bg-amber-600 border-amber-500 text-white' 
              : 'bg-white border-slate-200 text-slate-900 shadow-sm'
        }`}>
          <div className="flex items-center gap-3">
             <div className={`w-8 h-8 rounded-lg flex items-center justify-center shadow-inner ${isLockedByMe ? 'bg-white/20' : lockOwner ? 'bg-black/10' : 'bg-slate-100 text-slate-400'}`}>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d={isLockedByMe ? "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" : "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"} />
                </svg>
             </div>
             <div>
                <p className="text-[10px] font-black uppercase tracking-widest leading-none">
                   {isLockedByMe ? 'ACTIVE SESSION' : lockOwner ? `LOCKED BY ${lockOwner.userName.toUpperCase()}` : 'READ-ONLY VIEW'}
                </p>
                <p className={`text-[9px] font-bold opacity-80 mt-0.5 ${isLockedByMe || lockOwner ? 'text-white/80' : 'text-slate-500'}`}>
                   {isLockedByMe ? (isDirty ? 'Unsaved overrides detected' : 'Synchronized with defaults') : lockOwner ? 'Wait for release to modify' : 'Sign on to enable edits'}
                </p>
             </div>
          </div>
          
          <div className="flex gap-2">
             {!isLockedByMe && !lockOwner && (
                <button type="button" onClick={onSignOn} className="px-4 py-1.5 bg-indigo-600 text-white text-[9px] font-black rounded-lg hover:bg-indigo-700 transition-all uppercase tracking-widest shadow-lg shadow-indigo-300/30">
                  Sign On
                </button>
             )}
             {lockOwner && !isLockedByMe && (
               <button type="button" onClick={onSignOff} className="px-4 py-1.5 bg-white/10 text-white text-[9px] font-black rounded-lg hover:bg-white/20 transition-all border border-white/20 uppercase tracking-widest flex items-center gap-1.5">
                 <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                 Admin Force
               </button>
             )}
             {isLockedByMe && (
                <>
                  <button type="button" onClick={handleDiscardSessionChanges} disabled={!isDirty} className={`px-3 py-1.5 text-[9px] font-black rounded-lg transition-all uppercase tracking-widest ${isDirty ? 'bg-white/10 border border-white/20 text-white hover:bg-white/20' : 'bg-white/5 text-white/30 cursor-not-allowed'}`}>
                    Reset
                  </button>
                  <button type="button" onClick={commitToSystem} className="px-4 py-1.5 bg-white text-indigo-700 text-[9px] font-black rounded-lg hover:bg-indigo-50 transition-all shadow-md uppercase tracking-widest">
                    Save
                  </button>
                  <button type="button" onClick={onSignOff} className="px-4 py-1.5 bg-indigo-800 text-white text-[9px] font-black rounded-lg hover:bg-indigo-900 transition-all border border-indigo-400 uppercase tracking-widest">
                    Exit
                  </button>
                </>
             )}
          </div>
        </div>

        {/* Compact Summary Header */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="md:col-span-3 bg-white rounded-xl shadow-sm border border-slate-200 p-4 flex items-center gap-4">
            <div className="w-12 h-12 bg-slate-900 text-white rounded-lg flex items-center justify-center shrink-0">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-black text-slate-900 leading-none tracking-tight truncate">{item.itemId}</h2>
              <p className="text-slate-400 text-[10px] mt-1 font-bold uppercase tracking-wider truncate">{item.description}</p>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 flex flex-col justify-center">
            <h3 className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1.5">PLM Domain</h3>
            <div className="relative">
              <select
                disabled={isReadOnly}
                value={stagedClassId || ""}
                onChange={(e) => { isEditingRef.current = true; setStagedClassId(e.target.value); }}
                className={`w-full h-9 px-3 rounded-lg text-[10px] font-black transition-all appearance-none outline-none border ${isReadOnly ? 'bg-slate-50 border-transparent text-slate-700' : 'bg-white border-indigo-400 text-indigo-900'}`}
              >
                <option value="UNCLASSIFIED">Universal Schema</option>
                {classes.map(c => <option key={c.classId} value={c.classId}>{c.className}</option>)}
              </select>
              <div className="absolute right-2.5 top-2.5 pointer-events-none text-slate-400">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" /></svg>
              </div>
            </div>
          </div>
        </div>

        {/* Feature-wise Sleek Cards */}
        <div className="space-y-3">
          <div className="flex px-6 text-[9px] font-black text-slate-400 uppercase tracking-widest">
            <div className="w-1/4">Source Attribute</div>
            <div className="w-1/4">Structural Map</div>
            <div className="flex-1">Value Logic</div>
          </div>

          {item.features.map(f => {
            const localMap = stagedLocalMappings.find(m => m.legacyFeatureIds.includes(f.featureId));
            const globalMap = globalMappings.find(m => m.legacyFeatureIds.includes(f.featureId));
            const isLocal = !!localMap;
            const effectiveMapping = localMap || globalMap;
            
            return (
              <div key={f.featureId} className="flex bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden relative transition-all duration-300 hover:shadow-md hover:border-slate-300">
                <div className={`w-1.5 shrink-0 transition-colors ${isLocal ? 'bg-indigo-500' : 'bg-emerald-400'}`}></div>

                {/* Column 1: Feature Source */}
                <div className="w-1/4 p-5 flex flex-col justify-center border-r border-slate-100 bg-slate-50/20">
                    <p className="text-sm font-black text-slate-900 leading-tight">{f.featureId}</p>
                    <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">{f.description}</p>
                    {isLocal && (
                        <div className="mt-2 flex items-center gap-1.5">
                           <span className="w-1 h-1 rounded-full bg-indigo-500 animate-pulse"></span>
                           <span className="text-[8px] font-black text-indigo-500 uppercase">Override</span>
                        </div>
                    )}
                </div>

                {/* Column 2: Structural Bridge */}
                <div className="w-1/4 p-5 flex flex-col justify-center gap-2">
                  <div className="flex items-center justify-between">
                    <span className={`text-[8px] font-black uppercase tracking-widest ${isLocal ? 'text-indigo-600' : 'text-emerald-600'}`}>
                      {isLocal ? 'Session' : 'System'}
                    </span>
                    {isLocal && !isReadOnly && (
                      <button type="button" onClick={() => handleResetToGlobal(f.featureId)} className="text-[8px] font-black text-slate-400 hover:text-red-500 uppercase transition-colors">
                        Restore
                      </button>
                    )}
                  </div>

                  <div className="relative">
                    <select 
                      disabled={isReadOnly}
                      value={effectiveMapping?.newAttributeId || ""}
                      onChange={(e) => handleUpdateLinkage(f.featureId, e.target.value)}
                      className={`w-full h-9 px-2 text-[10px] font-black rounded-lg outline-none transition-all ${
                        isLocal 
                          ? 'bg-white border border-indigo-300 text-indigo-900 ring-2 ring-indigo-50' 
                          : 'bg-emerald-50/30 border border-emerald-100 text-emerald-900'
                      } disabled:appearance-none`}
                    >
                      <option value="">( Unmapped )</option>
                      {targetAttributes.map(a => <option key={a.attributeId} value={a.attributeId}>{a.attributeId}</option>)}
                    </select>
                  </div>
                </div>

                {/* Column 3: Transformation Logic */}
                <div className="flex-1 p-5 flex flex-wrap gap-3 items-center bg-slate-50/10">
                  {f.values.map(v => {
                    const mappedVal = effectiveMapping?.valueMappings[v];
                    const isValLocal = localMap && localMap.valueMappings && localMap.valueMappings[v] !== undefined;
                    const hasValidMapping = !!mappedVal;
                    
                    return (
                      <div key={v} className={`flex-1 min-w-[240px] p-3.5 rounded-xl border transition-all ${isValLocal ? 'bg-white border-indigo-200 shadow-sm' : hasValidMapping ? 'bg-white/60 border-emerald-100' : 'bg-orange-50/30 border-orange-200 border-dashed'}`}>
                        <div className="flex items-center gap-3 mb-2.5">
                            <div className="px-2.5 py-1.5 bg-slate-900 text-white rounded-lg text-[9px] font-black uppercase tracking-tight flex-1 text-center truncate">
                              {v}
                            </div>
                            <svg className={`w-3.5 h-3.5 shrink-0 ${isValLocal ? 'text-indigo-400' : hasValidMapping ? 'text-emerald-400' : 'text-orange-300'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                            </svg>
                            <div className={`px-2.5 py-1.5 rounded-lg text-[9px] font-black uppercase flex-1 text-center truncate transition-all ${isValLocal ? 'bg-indigo-600 text-white' : hasValidMapping ? 'bg-emerald-600 text-white' : 'bg-orange-500 text-white'}`}>
                              {mappedVal || 'REQUIRES INPUT'}
                            </div>
                        </div>

                        {!isReadOnly && (
                          <div className="relative">
                            <input 
                              type="text"
                              placeholder="Assign Target Value..."
                              value={manualInputs[`${f.featureId}-${v}`] ?? mappedVal ?? ''}
                              onChange={(e) => handleManualInputChange(`${f.featureId}-${v}`, e.target.value)}
                              onBlur={() => handleUpdateValue(f.featureId, v, manualInputs[`${f.featureId}-${v}`] || mappedVal || '')}
                              className={`w-full text-[10px] h-8 px-2.5 rounded-lg border transition-all font-bold focus:outline-none ${isValLocal ? 'bg-white border-indigo-400 ring-2 ring-indigo-50 text-indigo-900' : 'bg-slate-50 border-slate-200 focus:bg-white focus:border-indigo-400 text-slate-900'}`}
                            />
                            <div className="absolute right-2.5 top-2 text-slate-300">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default MappingWorkspace;
