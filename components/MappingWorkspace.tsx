
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { LegacyItem, NewClassification, GlobalMapping, LocalItemMappings, NewAttribute, ItemLock, User } from '../types';

const SearchableSelect = ({ value, options, onChange }: { value: string, options: string[], onChange: (val: string) => void }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredOptions = options.filter(opt => opt.toLowerCase().includes(search.toLowerCase()));

  return (
    <div ref={wrapperRef} className="relative mb-2">
      <div 
        className="w-full px-3 py-2 pr-8 bg-white border-2 border-emerald-300 rounded-lg text-[10px] font-black text-emerald-800 uppercase tracking-tight cursor-pointer hover:bg-emerald-50 transition-colors outline-none focus:ring-2 focus:ring-emerald-400 flex items-center justify-between"
        onClick={() => { setIsOpen(!isOpen); setSearch(''); }}
      >
        <span className="truncate">{value}</span>
        <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-emerald-600">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>
      
      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-white border-2 border-emerald-300 rounded-lg shadow-lg max-h-48 flex flex-col overflow-hidden" style={{ minWidth: '100%' }}>
          <div className="p-2 border-b border-emerald-100 bg-slate-50">
            <input
              type="text"
              className="w-full px-2 py-1.5 text-[10px] font-bold text-slate-700 bg-white border border-slate-200 rounded outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
              placeholder="Search attributes..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          </div>
          <div className="overflow-y-auto flex-1">
            {filteredOptions.length > 0 ? filteredOptions.map((opt, idx) => (
              <div
                key={idx}
                className={`px-3 py-2 text-[10px] font-black uppercase tracking-tight cursor-pointer hover:bg-emerald-100 ${opt === value ? 'bg-emerald-50 text-emerald-800' : 'text-slate-700'}`}
                onClick={() => {
                  onChange(opt);
                  setIsOpen(false);
                }}
              >
                {opt}
              </div>
            )) : (
              <div className="px-3 py-3 text-[10px] font-bold text-slate-400 text-center">No results found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const LegacyFilterDropdown = ({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (val: string) => void;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredOptions = useMemo(() => {
    const q = search.toLowerCase();
    return options
      .filter(opt => opt.toLowerCase().includes(q))
      .slice(0, 20);
  }, [options, search]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setIsOpen(o => !o);
          setSearch('');
        }}
        className="w-44 h-7 px-2 pr-6 rounded-lg border border-slate-200 bg-white text-[9px] font-black text-slate-600 uppercase tracking-widest flex items-center justify-between shadow-sm hover:bg-slate-50"
      >
        <span className="truncate">
          {value.trim() ? value : 'Filter legacy...'}
        </span>
        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>

      {isOpen && options.length > 0 && (
        <div className="absolute z-40 mt-1 w-56 bg-white border border-slate-200 rounded-lg shadow-lg max-h-64 overflow-hidden">
          <div className="p-2 border-b border-slate-100 bg-slate-50">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-2 py-1.5 text-[9px] font-bold text-slate-700 bg-white border border-slate-200 rounded outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
              placeholder="Search features & values..."
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filteredOptions.length > 0 ? (
              filteredOptions.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => {
                    onChange(opt);
                    setIsOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-[9px] font-black uppercase tracking-tight hover:bg-indigo-50 text-slate-700 truncate"
                >
                  {opt}
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-[9px] font-bold text-slate-400 text-center">No matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const ValueSelector = ({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: string[];
  disabled?: boolean;
  onChange: (val: string) => void;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredOptions = useMemo(() => {
    const q = search.toLowerCase();
    return options
      .filter(opt => opt.toLowerCase().includes(q))
      .slice(0, 20);
  }, [options, search]);

  return (
    <div ref={wrapperRef} className="relative">
      <div className="flex items-center gap-1">
        <input
          type="text"
          disabled={disabled}
          value={value}
          onChange={(e) => !disabled && onChange(e.target.value)}
          className={`flex-1 px-3 py-1.5 rounded-lg border text-[9px] font-black uppercase tracking-tight outline-none transition-all ${
            disabled
              ? 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed'
              : 'bg-white border-emerald-300 text-emerald-800 focus:ring-1 focus:ring-emerald-400'
          }`}
        />
        <button
          type="button"
          disabled={disabled || options.length === 0}
          onClick={() => {
            if (disabled || options.length === 0) return;
            setIsOpen(o => !o);
            setSearch('');
          }}
          className={`w-7 h-7 flex items-center justify-center rounded-md border text-emerald-700 bg-white shadow-sm text-[10px] ${
            disabled || options.length === 0
              ? 'opacity-40 cursor-not-allowed border-slate-200'
              : 'border-emerald-200 hover:bg-emerald-50'
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {isOpen && !disabled && (
        <div className="absolute z-40 mt-1 w-full bg-white border border-emerald-200 rounded-lg shadow-lg max-h-56 overflow-hidden">
          <div className="p-2 border-b border-slate-100 bg-slate-50">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-2 py-1.5 text-[9px] font-bold text-slate-700 bg-white border border-slate-200 rounded outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
              placeholder="Search target values..."
            />
          </div>
          <div className="max-h-40 overflow-y-auto">
            {filteredOptions.length > 0 ? (
              filteredOptions.map((opt, idx) => (
                <div
                  key={idx}
                  className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-tight cursor-pointer hover:bg-emerald-50 ${
                    opt === value ? 'bg-emerald-50 text-emerald-800' : 'text-slate-700'
                  }`}
                  onClick={() => {
                    onChange(opt);
                    setIsOpen(false);
                  }}
                >
                  {opt}
                </div>
              ))
            ) : (
              <div className="px-3 py-2 text-[9px] font-bold text-slate-400 text-center">No matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

interface MappingWorkspaceProps {
  item: LegacyItem | null;
  classes: NewClassification[];
  globalMappings: GlobalMapping[];
  localItemMappings: LocalItemMappings;
  assignedClassId?: string | null;
  isLockedByMe: boolean;
  lockOwner: ItemLock | null;
  currentUser: User;
  onSignOn: () => Promise<void>;
  onSignOff: () => Promise<void>;
  onSaveChanges: (updates: any) => Promise<void>;
  onSyncFromDB: () => void;
}

const MappingWorkspace: React.FC<MappingWorkspaceProps> = ({ 
  item, 
  classes, 
  globalMappings, 
  localItemMappings, 
  assignedClassId,
  isLockedByMe,
  lockOwner,
  currentUser,
  onSignOn,
  onSignOff,
  onSaveChanges,
  onSyncFromDB
}) => {
  const [manualInputs, setManualInputs] = useState<Record<string, string>>({});
  const [stagedLocalMappings, setStagedLocalMappings] = useState<GlobalMapping[]>([]);
  const [stagedClassId, setStagedClassId] = useState<string | null>(null);
  const [legacyFilter, setLegacyFilter] = useState('');
  const [showUnmappedOnly, setShowUnmappedOnly] = useState(false);
  const isEditingRef = useRef(false);

  // Initialize workspace when item changes
  useEffect(() => {
    if (item) {
      // Always re-initialize view state when the selected item or backing data changes.
      isEditingRef.current = false;
      setStagedClassId(assignedClassId || 'UNCLASSIFIED');
      setStagedLocalMappings(JSON.parse(JSON.stringify(localItemMappings[item.itemId] || [])));
      setManualInputs({});
      setLegacyFilter('');
      setShowUnmappedOnly(false);
    } else {
      isEditingRef.current = false;
      setStagedClassId(null);
      setStagedLocalMappings([]);
      setManualInputs({});
      setLegacyFilter('');
      setShowUnmappedOnly(false);
    }
  }, [item, assignedClassId, localItemMappings]);

  const handleManualInputChange = (key: string, value: string) => {
    if (!isLockedByMe) return;
    isEditingRef.current = true;
    setManualInputs(prev => ({ ...prev, [key]: value }));
  };

  const commitToSystem = async () => {
    if (!item) return;
    await onSaveChanges({
      localMappings: { [item.itemId]: stagedLocalMappings },
      itemClassifications: { [item.itemId]: stagedClassId || 'UNCLASSIFIED' }
    });
    isEditingRef.current = false;
  };

  const handleExitSession = async () => {
    if (!item) return;
    // Save any pending changes before exiting
    if (isEditingRef.current) {
      await commitToSystem();
    }
    // Then sign off (this is async and should complete the lock release)
    await onSignOff();
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

    return attrs;
  }, [stagedClassId, classes, allSystemAttributes]);

  const attributeCandidateValues = useMemo(() => {
    const byAttr: Record<string, string[]> = {};

    // Collect values from global mappings (target-side values)
    globalMappings.forEach(m => {
      const attrId = m.newAttributeId;
      if (!attrId) return;
      if (!byAttr[attrId]) byAttr[attrId] = [];
      Object.values(m.valueMappings || {}).forEach(val => {
        if (!val) return;
        if (!byAttr[attrId].includes(val)) byAttr[attrId].push(val);
      });
    });

    // Merge in classification allowedValues, if present
    classes.forEach(cls => {
      cls.attributes.forEach(attr => {
        if (!attr.allowedValues || attr.allowedValues.length === 0) return;
        const list = (byAttr[attr.attributeId] = byAttr[attr.attributeId] || []);
        attr.allowedValues.forEach(v => {
          if (!list.includes(v)) list.push(v);
        });
      });
    });

    return byAttr;
  }, [globalMappings, classes]);

  const legacyFilterOptions = useMemo(() => {
    if (!item) return [] as string[];
    const set = new Set<string>();
    item.features.forEach(f => {
      if (f.featureId) set.add(f.featureId);
      if (f.description) set.add(f.description);
      f.values.forEach(v => set.add(v));
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [item]);

  const unmappedStats = useMemo(() => {
    if (!item) return { attributes: 0, values: 0, totalAttributes: 0, totalValues: 0 };

    let attrCount = 0;
    let valueCount = 0;
    let totalAttrCount = 0;
    let totalValueCount = 0;

    item.features.forEach(f => {
      totalAttrCount += 1;
      totalValueCount += f.values.length;

      const globalMapping = globalMappings.find(m => m.legacyFeatureIds.includes(f.featureId));
      const localOverride = stagedLocalMappings.find(m => m.legacyFeatureIds.includes(f.featureId));

      const baseTargetAttributeId = globalMapping?.newAttributeId || 'UNMAPPED';
      let attributeOptions = baseTargetAttributeId
        .split(';')
        .map(a => a.trim())
        .filter(a => a && a !== 'UNMAPPED');

      const defaultGlobalAttribute = attributeOptions.length > 0 ? attributeOptions[0] : 'UNMAPPED';

      const isUnmapped = attributeOptions.length === 0;
      if (isUnmapped) {
        attributeOptions = ['UNMAPPED', ...targetAttributes.map(a => a.attributeId)];
      }

      if (localOverride && localOverride.newAttributeId !== 'UNMAPPED' && !attributeOptions.includes(localOverride.newAttributeId)) {
        attributeOptions.push(localOverride.newAttributeId);
      }

      if (localOverride && localOverride.newAttributeId === 'UNMAPPED' && !attributeOptions.includes('UNMAPPED')) {
        attributeOptions = ['UNMAPPED', ...attributeOptions];
      }

      if ((isUnmapped || attributeOptions.length > 1 || !!localOverride) && !attributeOptions.includes('UNMAPPED')) {
        attributeOptions = ['UNMAPPED', ...attributeOptions];
      }

      const selectedAttribute = localOverride?.newAttributeId || defaultGlobalAttribute;
      const effectiveMapping = localOverride || globalMapping;

      if (selectedAttribute === 'UNMAPPED') {
        attrCount += 1;
      }

      f.values.forEach(v => {
        const isValueMapped = effectiveMapping?.valueMappings?.[v] !== undefined;
        if (!isValueMapped) {
          valueCount += 1;
        }
      });
    });

    return {
      attributes: attrCount,
      values: valueCount,
      totalAttributes: totalAttrCount,
      totalValues: totalValueCount,
    };
  }, [item, globalMappings, stagedLocalMappings, targetAttributes]);

  const attributeBadgeClasses = unmappedStats.attributes > 0
    ? 'bg-rose-50 text-rose-600 border border-rose-100'
    : 'bg-emerald-50 text-emerald-600 border border-emerald-100';

  const valueBadgeClasses = unmappedStats.values > 0
    ? 'bg-rose-50 text-rose-600 border border-rose-100'
    : 'bg-emerald-50 text-emerald-600 border border-emerald-100';

  const handleUpdateLinkage = (featureId: string, attrId: string) => {
    if (!isLockedByMe) return;
    isEditingRef.current = true;
    setStagedLocalMappings(prev => {
      const filtered = prev.filter(m => !m.legacyFeatureIds.includes(featureId));
      const globalRef = globalMappings.find(m => m.legacyFeatureIds.includes(featureId));
      
      if (attrId === 'UNMAPPED' && !globalRef) {
        return filtered;
      }
      
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
          
          <div className="flex items-center gap-3">
             {/* PLM Domain selector moved next to Active Session banner */}
             <div className="hidden sm:flex flex-col items-end mr-1">
               <span className="text-[8px] font-black uppercase tracking-widest mb-0.5">
                 PLM Domain
               </span>
               <div className="relative">
                 <select
                   disabled={isReadOnly}
                   value={stagedClassId || ""}
                   onChange={(e) => { isEditingRef.current = true; setStagedClassId(e.target.value); }}
                   className={`w-40 h-8 pl-2 pr-6 rounded-lg text-[9px] font-black transition-all appearance-none outline-none border ${
                     isReadOnly ? 'bg-slate-50 border-transparent text-slate-700' : 'bg-white border-indigo-400 text-indigo-900'
                   }`}
                 >
                   <option value="UNCLASSIFIED">Universal Schema</option>
                   {classes.map(c => <option key={c.classId} value={c.classId}>{c.className}</option>)}
                 </select>
                 <div className="absolute right-1.5 top-1.5 pointer-events-none text-slate-400">
                   <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" /></svg>
                 </div>
               </div>
             </div>

             <div className="flex gap-2">
             {!isLockedByMe && !lockOwner && (
                <button type="button" onClick={() => onSignOn().catch(e => console.error("Sign on failed:", e))} className="px-4 py-1.5 bg-indigo-600 text-white text-[9px] font-black rounded-lg hover:bg-indigo-700 transition-all uppercase tracking-widest shadow-lg shadow-indigo-300/30">
                  Sign On
                </button>
             )}
             {lockOwner && !isLockedByMe && currentUser.role === 'admin' && (
               <button type="button" onClick={() => onSignOff().catch(e => console.error("Force release failed:", e))} className="px-4 py-1.5 bg-white/10 text-white text-[9px] font-black rounded-lg hover:bg-white/20 transition-all border border-white/20 uppercase tracking-widest flex items-center gap-1.5">
                 <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                 Admin Force
               </button>
             )}
             {isLockedByMe && (
                <>
                  <button type="button" onClick={handleDiscardSessionChanges} disabled={!isDirty} className={`px-3 py-1.5 text-[9px] font-black rounded-lg transition-all uppercase tracking-widest ${isDirty ? 'bg-white/10 border border-white/20 text-white hover:bg-white/20' : 'bg-white/5 text-white/30 cursor-not-allowed'}`}>
                    Reset
                  </button>
                  <button type="button" onClick={() => commitToSystem().catch(e => console.error("Save failed:", e))} className="px-4 py-1.5 bg-white text-indigo-700 text-[9px] font-black rounded-lg hover:bg-indigo-50 transition-all shadow-md uppercase tracking-widest">
                    Save
                  </button>
                  <button type="button" onClick={() => handleExitSession().catch(e => console.error("Exit failed:", e))} className="px-4 py-1.5 bg-indigo-800 text-white text-[9px] font-black rounded-lg hover:bg-indigo-900 transition-all border border-indigo-400 uppercase tracking-widest">
                    Exit
                  </button>
                </>
             )}
               </div>
            </div>
        </div>
          {/* Feature list (view-only for now) */}
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_auto_1fr] gap-4 px-6 text-[9px] font-black text-slate-400 uppercase tracking-widest items-center">
              <div>Source Attribute</div>
              <div className="text-center">→</div>
              <div className="flex items-center justify-between gap-3">
                <span>Target Mapping</span>
                <div className="flex items-center gap-3">
                  {legacyFilterOptions.length > 0 && (
                    <div className="flex items-center gap-2">
                      <LegacyFilterDropdown
                        value={legacyFilter}
                        options={legacyFilterOptions}
                        onChange={(val) => setLegacyFilter(val)}
                      />
                      {legacyFilter && (
                        <button
                          type="button"
                          onClick={() => setLegacyFilter('')}
                          className="px-2 py-1 rounded-md border border-slate-200 bg-white text-[8px] font-black uppercase tracking-widest text-slate-400 hover:text-slate-600 hover:bg-slate-50"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowUnmappedOnly(v => !v)}
                      className={`flex items-center gap-2 px-3 py-1 rounded-full border text-[8px] font-black uppercase tracking-widest transition-all ${
                        showUnmappedOnly
                          ? 'bg-emerald-600 border-emerald-500 text-white shadow-sm'
                          : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                      }`}
                    >
                      <span>Unmapped Only</span>
                      <span
                        className={`relative inline-flex h-3 w-6 items-center rounded-full border transition-colors ${
                          showUnmappedOnly ? 'bg-white/20 border-white' : 'bg-slate-100 border-slate-300'
                        }`}
                      >
                        <span
                          className={`inline-block h-2.5 w-2.5 rounded-full bg-white shadow transform transition-transform ${
                            showUnmappedOnly ? 'translate-x-2.5' : 'translate-x-0.5'
                          }`}
                        />
                      </span>
                    </button>
                    <div className="text-[8px] font-black uppercase tracking-widest text-slate-500 flex flex-col gap-0.5 min-w-[160px]">
                      <div className="flex items-center gap-1">
                        <span className="text-slate-400">Attr</span>
                        <span className={`px-1.5 py-0.5 rounded-full ${attributeBadgeClasses}`}>
                          {unmappedStats.attributes}
                        </span>
                        <span className="text-slate-300">/</span>
                        <span className="px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">
                          {unmappedStats.totalAttributes}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-slate-400">Values</span>
                        <span className={`px-1.5 py-0.5 rounded-full ${valueBadgeClasses}`}>
                          {unmappedStats.values}
                        </span>
                        <span className="text-slate-300">/</span>
                        <span className="px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">
                          {unmappedStats.totalValues}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
          </div>

          {item.features.map((f, idx) => {
            // Find global mapping for this feature
            const globalMapping = globalMappings.find(m => m.legacyFeatureIds.includes(f.featureId));
            const localOverride = stagedLocalMappings.find(m => m.legacyFeatureIds.includes(f.featureId));
            const effectiveMapping = localOverride || globalMapping;

            // The base target attribute comes from global mapping if it exists
            const baseTargetAttributeId = globalMapping?.newAttributeId || 'UNMAPPED';

            // Parse semicolon-separated attributes from the GLOBAL mapping to preserve the options
            let attributeOptions = baseTargetAttributeId.split(';').map(a => a.trim()).filter(a => a && a !== 'UNMAPPED');

            // The default selected attribute if there is no local override
            const defaultGlobalAttribute = attributeOptions.length > 0 ? attributeOptions[0] : 'UNMAPPED';

            // If there are no options (unmapped), we should provide ALL attributes from the classification table
            const isUnmapped = attributeOptions.length === 0;
            if (isUnmapped) {
              attributeOptions = ['UNMAPPED', ...targetAttributes.map(a => a.attributeId)];
            }

            // Ensure local override is in the options if it exists
            if (localOverride && localOverride.newAttributeId !== 'UNMAPPED' && !attributeOptions.includes(localOverride.newAttributeId)) {
              attributeOptions.push(localOverride.newAttributeId);
            }

            // If there is a local override that is 'UNMAPPED', we need to ensure 'UNMAPPED' is in the options
            // so the user can switch back to the global mapping
            if (localOverride && localOverride.newAttributeId === 'UNMAPPED' && !attributeOptions.includes('UNMAPPED')) {
              attributeOptions = ['UNMAPPED', ...attributeOptions];
            }

            // It has multiple options if it's unmapped (all attributes) OR if the global mapping had multiple options OR if there's a local override
            const hasMultipleOptions = isUnmapped || attributeOptions.length > 1 || !!localOverride;

            if (hasMultipleOptions && !attributeOptions.includes('UNMAPPED')) {
              attributeOptions = ['UNMAPPED', ...attributeOptions];
            }

            // The currently selected attribute is the local override, OR the default global attribute
            const selectedAttribute = localOverride?.newAttributeId || defaultGlobalAttribute;

            // It has a mapping if the selected attribute is not 'UNMAPPED'
            const hasMapping = selectedAttribute !== 'UNMAPPED';

            if (legacyFilter.trim()) {
              const q = legacyFilter.toLowerCase();
              const matchesFeatureId = f.featureId.toLowerCase().includes(q);
              const matchesDescription = (f.description || '').toLowerCase().includes(q);
              const matchesValue = f.values.some(v => v.toLowerCase().includes(q));
              if (!matchesFeatureId && !matchesDescription && !matchesValue) {
                return null;
              }
            }
            const featureHasUnmappedAttribute = selectedAttribute === 'UNMAPPED';
            const featureHasUnmappedValues = f.values.some(v => effectiveMapping?.valueMappings?.[v] === undefined);

            if (showUnmappedOnly && !featureHasUnmappedAttribute && !featureHasUnmappedValues) {
              return null;
            }

            const candidateValuesForAttribute = attributeCandidateValues[selectedAttribute] || [];

            return (
              <div
                key={`${item.itemId}-${f.featureId}-${idx}`}
                className={`bg-white rounded-xl shadow-sm border relative transition-all duration-300 hover:shadow-md ${hasMapping ? 'border-emerald-200' : 'border-slate-200'}`}
              >
                <div className={`w-1.5 shrink-0 absolute left-0 top-0 bottom-0 rounded-l-xl ${hasMapping ? 'bg-emerald-400' : 'bg-slate-300'}`}></div>

                <div className="p-5 pl-8 pr-6">
                  {/* Header row: source feature meta on the left, attribute selector/badges on the right */}
                  <div className="flex items-start justify-between gap-6">
                    <div>
                      <p className="text-sm font-black text-slate-900 leading-tight">{f.featureId}</p>
                      <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">{f.description}</p>
                    </div>

                    <div className="flex flex-col items-end gap-1 min-w-[220px]">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {localOverride && (
                          <span className="px-2 py-0.5 bg-purple-100 text-purple-700 text-[7px] font-black rounded-full uppercase tracking-wider">
                            Local
                          </span>
                        )}
                        {globalMapping && !localOverride && (
                          <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-[7px] font-black rounded-full uppercase tracking-wider">
                            Global
                          </span>
                        )}
                        {hasMultipleOptions && !isLockedByMe && (
                          <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-[7px] font-black rounded-full uppercase tracking-wider">
                            Multiple Options
                          </span>
                        )}
                      </div>

                      {/* Target Attribute Selector/Display */}
                      <div className="w-full max-w-xs">
                        {hasMultipleOptions && isLockedByMe ? (
                          <SearchableSelect
                            value={selectedAttribute}
                            options={attributeOptions}
                            onChange={(val) => handleUpdateLinkage(f.featureId, val)}
                          />
                        ) : (
                          <p
                            className={`px-3 py-2 border rounded-lg text-[10px] font-black uppercase tracking-tight text-right truncate ${
                              hasMapping
                                ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                                : 'border-slate-200 bg-slate-50 text-slate-400'
                            }`}
                          >
                            {selectedAttribute}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Per-value rows: ensure strict left/right alignment */}
                  <div className="mt-4 space-y-2">
                    {f.values.map((v, vidx) => {
                      const isValueMapped = effectiveMapping?.valueMappings?.[v] !== undefined;
                      const mappedValue = isValueMapped ? effectiveMapping!.valueMappings![v] : '';

                      if (showUnmappedOnly && !featureHasUnmappedAttribute && isValueMapped) {
                        return null;
                      }

                      return (
                        <div
                          key={`${item.itemId}-${f.featureId}-row-${vidx}`}
                          className="grid grid-cols-[1fr_auto_1fr] gap-4 items-center"
                        >
                          <div className="px-3 py-2 bg-slate-900 text-white rounded-lg text-[9px] font-black uppercase tracking-tight truncate">
                            {v}
                          </div>

                          <div className="flex items-center justify-center text-2xl font-black text-slate-300">
                            →
                          </div>

                          <div>
                            {isReadOnly ? (
                              <div
                                className={`px-3 py-2 rounded-lg text-[9px] font-black uppercase tracking-tight truncate ${
                                  isValueMapped ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'
                                }`}
                              >
                                {mappedValue}
                              </div>
                            ) : (
                              <ValueSelector
                                value={mappedValue}
                                options={candidateValuesForAttribute}
                                disabled={isReadOnly}
                                onChange={(newVal) => handleUpdateValue(f.featureId, v, newVal)}
                              />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
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
