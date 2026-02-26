
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { LegacyItem, NewClassification, GlobalMapping, LocalItemMappings, NewAttribute, ItemLock, User, FeatureFlags } from '../types';

type Tone = 'mapped' | 'unmapped' | 'notRequired';

const toneTheme: Record<Tone, {
  trigger: string;
  dropdownBorder: string;
  optionActive: string;
  optionHover: string;
  card: string;
  accent: string;
  attrReadonly: string;
  valueWrapper: string;
  valueReadonly: string;
  valueInput: string;
  valueButton: string;
}> = {
  mapped: {
    trigger: 'bg-emerald-50 border-emerald-300 text-emerald-800 focus:ring-emerald-400 focus:border-emerald-400',
    dropdownBorder: 'border-emerald-200',
    optionActive: 'bg-emerald-100 text-emerald-800',
    optionHover: 'hover:bg-emerald-100',
    card: 'bg-emerald-50/60 border-emerald-200',
    accent: 'bg-emerald-500',
    attrReadonly: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    valueWrapper: 'bg-emerald-50 border border-emerald-100',
    valueReadonly: 'bg-emerald-600 text-white',
    valueInput: 'bg-emerald-50 border-emerald-300 text-emerald-800 focus:ring-emerald-300 focus:border-emerald-300',
    valueButton: 'border-emerald-200 text-emerald-700',
  },
  unmapped: {
    trigger: 'bg-rose-50 border-rose-300 text-rose-800 focus:ring-rose-400 focus:border-rose-400',
    dropdownBorder: 'border-rose-200',
    optionActive: 'bg-rose-100 text-rose-800',
    optionHover: 'hover:bg-rose-100',
    card: 'bg-rose-50/60 border-rose-200',
    accent: 'bg-rose-500',
    attrReadonly: 'border-rose-200 bg-rose-50 text-rose-800',
    valueWrapper: 'bg-rose-50 border border-rose-100',
    valueReadonly: 'bg-rose-600 text-white',
    valueInput: 'bg-rose-50 border-rose-300 text-rose-800 focus:ring-rose-300 focus:border-rose-300',
    valueButton: 'border-rose-200 text-rose-700',
  },
  notRequired: {
    trigger: 'bg-amber-50 border-amber-300 text-amber-800 focus:ring-amber-400 focus:border-amber-400',
    dropdownBorder: 'border-amber-200',
    optionActive: 'bg-amber-100 text-amber-800',
    optionHover: 'hover:bg-amber-100',
    card: 'bg-amber-50/60 border-amber-200',
    accent: 'bg-amber-500',
    attrReadonly: 'border-amber-200 bg-amber-50 text-amber-800',
    valueWrapper: 'bg-amber-50 border border-amber-100',
    valueReadonly: 'bg-amber-400 text-white',
    valueInput: 'bg-amber-50 border-amber-300 text-amber-800 focus:ring-amber-300 focus:border-amber-300',
    valueButton: 'border-amber-200 text-amber-700',
  },
};

const SearchableSelect = ({ value, options, onChange, tone = 'mapped' }: { value: string, options: string[], onChange: (val: string) => void, tone?: Tone }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const palette = toneTheme[tone];

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
        className={`w-full px-3 py-2 pr-8 border-2 rounded-lg text-[10px] font-black uppercase tracking-tight cursor-pointer transition-colors outline-none flex items-center justify-between ${palette.trigger}`}
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
        <div className={`absolute z-50 w-full mt-1 bg-white border-2 rounded-lg shadow-lg max-h-48 flex flex-col overflow-hidden ${palette.dropdownBorder}`} style={{ minWidth: '100%' }}>
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
                className={`px-3 py-2 text-[10px] font-black uppercase tracking-tight cursor-pointer ${palette.optionHover} ${opt === value ? palette.optionActive : 'text-slate-700'}`}
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

const ClassDomainSelect = ({
  value,
  classes,
  disabled,
  onChange,
}: {
  value: string | null;
  classes: NewClassification[];
  disabled?: boolean;
  onChange: (classId: string) => void;
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

  const allOptions = useMemo(
    () => [
      { classId: 'UNCLASSIFIED', className: 'Universal Schema' },
      ...classes.map(c => ({ classId: c.classId, className: c.className })),
    ],
    [classes]
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return allOptions.filter(o =>
      o.className.toLowerCase().includes(q) || o.classId.toLowerCase().includes(q)
    );
  }, [allOptions, search]);

  const selected = allOptions.find(o => o.classId === (value || 'UNCLASSIFIED')) || allOptions[0];

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setIsOpen(o => !o);
          setSearch('');
        }}
        className={`w-40 h-8 pl-2 pr-6 rounded-lg text-[9px] font-black transition-all appearance-none outline-none border flex items-center justify-between $${''}
          ${disabled ? 'bg-slate-50 border-transparent text-slate-700 cursor-not-allowed' : 'bg-white border-indigo-400 text-indigo-900 hover:bg-indigo-50'}`}
      >
        <span className="truncate text-left">{selected.className}</span>
        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>

      {isOpen && !disabled && (
        <div className="absolute z-50 mt-1 w-60 bg-white border border-slate-200 rounded-lg shadow-lg max-h-64 overflow-hidden">
          <div className="p-2 border-b border-slate-100 bg-slate-50">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-2 py-1.5 text-[9px] font-bold text-slate-700 bg-white border border-slate-200 rounded outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
              placeholder="Search classes..."
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.map(opt => (
              <button
                key={opt.classId}
                type="button"
                onClick={() => {
                  onChange(opt.classId);
                  setIsOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-[9px] font-black uppercase tracking-tight truncate ${
                  opt.classId === selected.classId
                    ? 'bg-indigo-50 text-indigo-800'
                    : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                {opt.className}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-[9px] font-bold text-slate-400 text-center">No matches</div>
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
  tone = 'mapped',
}: {
  value: string;
  options: string[];
  disabled?: boolean;
  onChange: (val: string) => void;
  tone?: Tone;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const palette = toneTheme[tone];

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
              : palette.valueInput
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
          className={`w-7 h-7 flex items-center justify-center rounded-md border bg-white shadow-sm text-[10px] ${
            disabled || options.length === 0
              ? 'opacity-40 cursor-not-allowed border-slate-200 text-slate-400'
              : palette.valueButton
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {isOpen && !disabled && (
        <div className={`absolute z-40 mt-1 w-full bg-white border rounded-lg shadow-lg max-h-56 overflow-hidden ${palette.dropdownBorder}`}>
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
                  className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-tight cursor-pointer ${
                      opt === value ? palette.optionActive : 'text-slate-700'
                    } ${palette.optionHover}`}
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
  classAttributeValues: Record<string, Record<string, string>>;
  assignedClassId?: string | null;
  isLockedByMe: boolean;
  lockOwner: ItemLock | null;
  currentUser: User;
  featureFlags: FeatureFlags;
  onToggleNewClassTargetMapping: () => void;
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
  classAttributeValues,
  assignedClassId,
  isLockedByMe,
  lockOwner,
  currentUser,
  featureFlags,
  onToggleNewClassTargetMapping,
  onSignOn,
  onSignOff,
  onSaveChanges,
  onSyncFromDB
}) => {
  const { useNewClassTargetMapping } = featureFlags;
  const normalizeAttrId = (id: string) => (id || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const [manualInputs, setManualInputs] = useState<Record<string, string>>({});
  const [stagedLocalMappings, setStagedLocalMappings] = useState<GlobalMapping[]>([]);
  const [stagedClassId, setStagedClassId] = useState<string | null>(null);
  const [legacyFilter, setLegacyFilter] = useState('');
  const [showUnmappedOnly, setShowUnmappedOnly] = useState(false);
  const [expandedFeatures, setExpandedFeatures] = useState<Record<string, boolean>>({});
  const [unmappedTargetsExpanded, setUnmappedTargetsExpanded] = useState(true);
  const isEditingRef = useRef(false);

  // Initialize workspace when item changes
  useEffect(() => {
    if (item) {
      // Always re-initialize view state when the selected item or backing data changes.
      isEditingRef.current = false;
      setStagedClassId(assignedClassId || 'UNCLASSIFIED');
      setStagedLocalMappings(JSON.parse(JSON.stringify(localItemMappings[item.itemId] || [])));
      const existingAttrValues = classAttributeValues[item.itemId] || {};
      const nextManual: Record<string, string> = {};
      Object.entries(existingAttrValues).forEach(([attrId, val]) => {
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          nextManual[`UNMAPPED::${attrId}`] = String(val);
        }
      });
      setManualInputs(nextManual);
      setLegacyFilter('');
      setShowUnmappedOnly(false);
      setExpandedFeatures({});
    } else {
      isEditingRef.current = false;
      setStagedClassId(null);
      setStagedLocalMappings([]);
      setManualInputs({});
      setLegacyFilter('');
      setShowUnmappedOnly(false);
      setExpandedFeatures({});
    }
  }, [item, assignedClassId, localItemMappings]);

  const handleManualInputChange = (key: string, value: string) => {
    if (!isLockedByMe) return;
    isEditingRef.current = true;
    setManualInputs(prev => ({ ...prev, [key]: value }));
  };

  const commitToSystem = async () => {
    if (!item) return;
    const manualForItem: Record<string, string> = {};
    Object.entries(manualInputs).forEach(([key, value]) => {
      if (!key.startsWith('UNMAPPED::')) return;
      const attrId = key.substring('UNMAPPED::'.length);
      if (!attrId) return;
      const trimmed = String(value || '').trim();
      if (trimmed) {
        manualForItem[attrId] = trimmed;
      }
    });
    await onSaveChanges({
      localMappings: { [item.itemId]: stagedLocalMappings },
      itemClassifications: { [item.itemId]: stagedClassId || 'UNCLASSIFIED' },
      classAttributeValues: manualForItem && Object.keys(manualForItem).length > 0
        ? { [item.itemId]: manualForItem }
        : { [item.itemId]: {} },
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
      const existingAttrValues = classAttributeValues[item.itemId] || {};
      const nextManual: Record<string, string> = {};
      Object.entries(existingAttrValues).forEach(([attrId, val]) => {
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          nextManual[`UNMAPPED::${attrId}`] = String(val);
        }
      });
      setManualInputs(nextManual);
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
    const seen = new Set<string>();
    const unique: NewAttribute[] = [];
    attrs.forEach(a => {
      if (!seen.has(a.attributeId)) {
        seen.add(a.attributeId);
        unique.push(a);
      }
    });
    return unique;
  }, [stagedClassId, classes, allSystemAttributes]);

  const classAttributeKeys = useMemo(() => {
    const set = new Set<string>();
    targetAttributes.forEach(attr => {
      const key = normalizeAttrId(attr.attributeId);
      if (key) set.add(key);
    });
    return set;
  }, [targetAttributes]);

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

    const globalByFeature: Record<string, GlobalMapping> = {};
    globalMappings.forEach(m => {
      m.legacyFeatureIds.forEach(fid => {
        globalByFeature[fid] = m;
      });
    });

    const localByFeature: Record<string, any> = {};
    stagedLocalMappings.forEach(m => {
      m.legacyFeatureIds.forEach(fid => {
        localByFeature[fid] = m;
      });
    });

    item.features.forEach(f => {
      totalAttrCount += 1;
      totalValueCount += f.values.length;

      const globalMapping = globalByFeature[f.featureId];
      const localOverride = localByFeature[f.featureId];

      const baseTargetAttributeId = globalMapping?.newAttributeId
        ? globalMapping.newAttributeId.replace(/\s+/g, '')
        : 'UNMAPPED';
      let attributeOptions = baseTargetAttributeId
        .split(';')
        .map(a => a.trim())
        .filter(a => a && a !== 'UNMAPPED');

      const defaultGlobalAttribute = attributeOptions.length > 0 ? attributeOptions[0] : 'UNMAPPED';

      const usingClassScope = useNewClassTargetMapping && (stagedClassId || 'UNCLASSIFIED') !== 'UNCLASSIFIED';
      let isUnmapped = attributeOptions.length === 0;

      if (usingClassScope) {
        const matchedForClass = attributeOptions.filter(a => {
          const key = normalizeAttrId(a);
          return key && classAttributeKeys.has(key);
        });

        if (matchedForClass.length > 0) {
          attributeOptions = matchedForClass;
          isUnmapped = false;
        } else {
          // none of the global candidates belong to this class – treat as unmapped
          attributeOptions = [];
          isUnmapped = true;
        }
      }

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

      // Deduplicate while preserving order so the dropdown only shows unique attribute IDs
      attributeOptions = Array.from(new Set(attributeOptions));

      let selectedAttribute = localOverride?.newAttributeId || defaultGlobalAttribute;

      if (usingClassScope) {
        const selectedKey = normalizeAttrId(selectedAttribute);
        if (
          selectedAttribute &&
          selectedAttribute !== 'UNMAPPED' &&
          selectedAttribute !== 'NOT REQUIRED' &&
          (!selectedKey || !classAttributeKeys.has(selectedKey))
        ) {
          selectedAttribute = 'UNMAPPED';
        }
      }
      const effectiveMapping = localOverride || globalMapping;

      if (selectedAttribute === 'UNMAPPED') {
        attrCount += 1;
      }

      f.values.forEach(v => {
        const isValueMapped = selectedAttribute !== 'UNMAPPED' && effectiveMapping?.valueMappings?.[v] !== undefined;
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

  const unmappedTargetAttributes = useMemo(() => {
    if (!item || !useNewClassTargetMapping) return [] as NewAttribute[];
    const classId = stagedClassId || 'UNCLASSIFIED';
    if (classId === 'UNCLASSIFIED') return [] as NewAttribute[];

    const usedKeys = new Set<string>();

    const globalByFeature: Record<string, GlobalMapping> = {};
    globalMappings.forEach(m => {
      m.legacyFeatureIds.forEach(fid => {
        globalByFeature[fid] = m;
      });
    });

    const localByFeature: Record<string, any> = {};
    stagedLocalMappings.forEach(m => {
      m.legacyFeatureIds.forEach(fid => {
        localByFeature[fid] = m;
      });
    });

    item.features.forEach(f => {
      const globalMapping = globalByFeature[f.featureId];
      const localOverride = localByFeature[f.featureId];

      const baseTargetAttributeId = globalMapping?.newAttributeId
        ? globalMapping.newAttributeId.replace(/\s+/g, '')
        : 'UNMAPPED';
      const parts = baseTargetAttributeId
        .split(';')
        .map(a => a.trim())
        .filter(a => a && a !== 'UNMAPPED');
      const defaultGlobalAttribute = parts.length > 0 ? parts[0] : 'UNMAPPED';
      const selectedAttribute = localOverride?.newAttributeId || defaultGlobalAttribute;
      const key = normalizeAttrId(selectedAttribute);
      if (
        selectedAttribute &&
        selectedAttribute !== 'UNMAPPED' &&
        selectedAttribute !== 'NOT REQUIRED' &&
        key
      ) {
        usedKeys.add(key);
      }
    });

    return targetAttributes.filter(attr => {
      const key = normalizeAttrId(attr.attributeId);
      return key && !usedKeys.has(key);
    });
  }, [item, useNewClassTargetMapping, stagedClassId, globalMappings, stagedLocalMappings, targetAttributes]);

  const unmappedTargetGroupTone: Tone = useMemo(() => {
    if (unmappedTargetAttributes.length === 0) return 'mapped';
    let hasUnmapped = false;
    let hasNotRequired = false;
    let hasMapped = false;

    unmappedTargetAttributes.forEach(attr => {
      const manualKey = `UNMAPPED::${attr.attributeId}`;
      const trimmed = (manualInputs[manualKey] || '').trim();
      if (!trimmed) {
        hasUnmapped = true;
      } else if (trimmed === 'NOT REQUIRED') {
        hasNotRequired = true;
      } else {
        hasMapped = true;
      }
    });

    if (hasUnmapped) return 'unmapped';
    if (hasMapped) return 'mapped';
    return hasNotRequired ? 'notRequired' : 'mapped';
  }, [unmappedTargetAttributes, manualInputs]);

  const unmappedTargetPalette = toneTheme[unmappedTargetGroupTone];

  const handleUpdateLinkage = (featureId: string, attrId: string) => {
    if (!isLockedByMe) return;
    if (!item) return;
    isEditingRef.current = true;

    // Precompute feature values so we can auto-populate NOT REQUIRED mappings
    const feature = item.features.find(f => f.featureId === featureId);
    const featureValues = feature?.values || [];

    setStagedLocalMappings(prev => {
      const filtered = prev.filter(m => !m.legacyFeatureIds.includes(featureId));
      const globalRef = globalMappings.find(m => m.legacyFeatureIds.includes(featureId));

      if (attrId === 'UNMAPPED' && !globalRef) {
        return filtered;
      }

      let nextValueMappings: Record<string, string> = {};

      if (attrId === 'NOT REQUIRED') {
        // When an attribute is marked as NOT REQUIRED, automatically
        // mark all of its existing legacy values as NOT REQUIRED too
        // so they count as fully mapped and disappear when filtering
        // by "Unmapped Only".
        featureValues.forEach(v => {
          nextValueMappings[v] = 'NOT REQUIRED';
        });
      } else if (globalRef && globalRef.valueMappings) {
        nextValueMappings = { ...globalRef.valueMappings };
      }

      return [
        ...filtered,
        {
          legacyFeatureIds: [featureId],
          newAttributeId: attrId,
          valueMappings: nextValueMappings,
        },
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
               <div className="flex items-center gap-3 mb-0.5">
                 <span className="text-[8px] font-black uppercase tracking-widest">
                   PLM Domain
                 </span>
                 <button
                   type="button"
                   onClick={onToggleNewClassTargetMapping}
                   className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[7px] font-black uppercase tracking-widest transition-colors ${
                     useNewClassTargetMapping
                       ? 'bg-emerald-600 border-emerald-500 text-white'
                       : 'bg-white border-slate-300 text-slate-500 hover:bg-slate-50'
                   }`}
                 >
                   <span>{useNewClassTargetMapping ? 'Class View' : 'Legacy View'}</span>
                   <span
                     className={`relative inline-flex h-3 w-5 items-center rounded-full border ${
                       useNewClassTargetMapping ? 'bg-white/20 border-white' : 'bg-slate-100 border-slate-300'
                     }`}
                   >
                     <span
                       className={`inline-block h-2 w-2 rounded-full bg-white shadow transform transition-transform ${
                         useNewClassTargetMapping ? 'translate-x-2' : 'translate-x-0.5'
                       }`}
                     />
                   </span>
                 </button>
               </div>
               <ClassDomainSelect
                 value={stagedClassId}
                 classes={classes}
                 disabled={isReadOnly}
                 onChange={(classId) => {
                   isEditingRef.current = true;
                   setStagedClassId(classId);
                 }}
               />
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

          {(() => {
            const globalByFeature: Record<string, GlobalMapping> = {};
            globalMappings.forEach(m => {
              m.legacyFeatureIds.forEach(fid => {
                globalByFeature[fid] = m;
              });
            });

            const localByFeature: Record<string, any> = {};
            stagedLocalMappings.forEach(m => {
              m.legacyFeatureIds.forEach(fid => {
                localByFeature[fid] = m;
              });
            });

            return item.features.map((f, idx) => {
              // Find global mapping for this feature
              const globalMapping = globalByFeature[f.featureId];
              const localOverride = localByFeature[f.featureId];
            const effectiveMapping = localOverride || globalMapping;

            // The base target attribute comes from global mapping if it exists
            const baseTargetAttributeId = globalMapping?.newAttributeId
              ? globalMapping.newAttributeId.replace(/\s+/g, '')
              : 'UNMAPPED';

            // Parse semicolon-separated attributes from the GLOBAL mapping to preserve the options
            let attributeOptions = baseTargetAttributeId
              .split(';')
              .map(a => a.trim())
              .filter(a => a && a !== 'UNMAPPED');

            const usingClassScope = useNewClassTargetMapping && (stagedClassId || 'UNCLASSIFIED') !== 'UNCLASSIFIED';

            // The default selected attribute if there is no local override. This may be
            // updated in class-scoped mode to the first candidate that actually exists
            // in the selected class.
            let defaultGlobalAttribute = attributeOptions.length > 0 ? attributeOptions[0] : 'UNMAPPED';

            // If there are no options (unmapped), we should provide ALL attributes from the classification table
            let isUnmapped = attributeOptions.length === 0;

            if (usingClassScope) {
              // In class view, try to keep the original GLOBAL mapping semantics by
              // first filtering the semicolon-separated candidates down to only
              // those attributes that exist in the selected class. If at least one
              // survives this filter, we treat the feature as mapped and prefer the
              // first matching candidate (for ACTRM this becomes COLOROFPLASTICPARTS
              // when it is the only member present in the class).
              const matchedForClass = attributeOptions.filter(a => {
                const key = normalizeAttrId(a);
                return key && classAttributeKeys.has(key);
              });

              if (matchedForClass.length > 0) {
                attributeOptions = matchedForClass;
                defaultGlobalAttribute = matchedForClass[0];
                isUnmapped = false;
              } else {
                // None of the global candidates belong to this class – fall back to
                // offering all attributes from the class and mark as unmapped.
                attributeOptions = targetAttributes.map(a => a.attributeId);
                isUnmapped = attributeOptions.length === 0;
              }
            }

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

            // Deduplicate while preserving order so the dropdown only shows unique attribute IDs
            attributeOptions = Array.from(new Set(attributeOptions));

            // When using class-scoped view, only offer target attributes that are not
            // already used by other features on this item (keep this feature's current
            // selection in the list so we don't strand existing mappings).
            if (usingClassScope) {
              const usedAttributeKeys = new Set<string>();
              item.features.forEach(otherFeature => {
                const gm = globalByFeature[otherFeature.featureId];
                const lo = localByFeature[otherFeature.featureId];
                const baseId = gm?.newAttributeId || 'UNMAPPED';
                let baseOptions = baseId
                  .split(';')
                  .map(a => a.trim())
                  .filter(a => a && a !== 'UNMAPPED');
                const defaultAttr = baseOptions.length > 0 ? baseOptions[0] : 'UNMAPPED';
                const sel = lo?.newAttributeId || defaultAttr;

                if (sel && sel !== 'UNMAPPED' && sel !== 'NOT REQUIRED') {
                  const key = normalizeAttrId(sel);
                  if (key && classAttributeKeys.has(key)) usedAttributeKeys.add(key);
                }
              });

              const currentSelectedForFeature = localOverride?.newAttributeId || defaultGlobalAttribute;
              const currentKey = normalizeAttrId(currentSelectedForFeature);
              attributeOptions = attributeOptions.filter(attrId => {
                // Always allow control options
                if (attrId === 'UNMAPPED' || attrId === 'NOT REQUIRED') return true;
                const key = normalizeAttrId(attrId);
                return key === currentKey || !usedAttributeKeys.has(key);
              });

              // Also allow the user to repoint to any class attributes that are
              // currently unused on this item ("unmapped" at the class level).
              if (unmappedTargetAttributes.length > 0) {
                unmappedTargetAttributes.forEach(attr => {
                  if (!attributeOptions.includes(attr.attributeId)) {
                    attributeOptions.push(attr.attributeId);
                  }
                });
              }

              // Deduplicate again after appending extra options.
              attributeOptions = Array.from(new Set(attributeOptions));
            }

            // Ensure "Not required" is always an explicit choice that counts as mapped
            if (!attributeOptions.includes('NOT REQUIRED')) {
              const otherOptions = attributeOptions.filter(a => a !== 'UNMAPPED');
              attributeOptions = ['UNMAPPED', 'NOT REQUIRED', ...otherOptions];
            }

            // The currently selected attribute is the local override, OR the default global attribute
            let selectedAttribute = localOverride?.newAttributeId || defaultGlobalAttribute;

            if (usingClassScope) {
              const selectedKey = normalizeAttrId(selectedAttribute);
              if (
                selectedAttribute &&
                selectedAttribute !== 'UNMAPPED' &&
                selectedAttribute !== 'NOT REQUIRED' &&
                (!selectedKey || !classAttributeKeys.has(selectedKey))
              ) {
                selectedAttribute = 'UNMAPPED';
              }
            }

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

            let candidateValuesForAttribute = attributeCandidateValues[selectedAttribute] || [];
            if (useNewClassTargetMapping && (stagedClassId || 'UNCLASSIFIED') !== 'UNCLASSIFIED') {
              const activeClass = classes.find(c => c.classId === (stagedClassId || 'UNCLASSIFIED'));
              const attrDef = activeClass?.attributes.find(a => normalizeAttrId(a.attributeId) === normalizeAttrId(selectedAttribute));
              if (attrDef && attrDef.allowedValues && attrDef.allowedValues.length > 0) {
                candidateValuesForAttribute = attrDef.allowedValues;
              }
            }
            const attributeTone: Tone = selectedAttribute === 'UNMAPPED'
              ? 'unmapped'
              : selectedAttribute === 'NOT REQUIRED'
              ? 'notRequired'
              : 'mapped';
            const attributePalette = toneTheme[attributeTone];
            const isExpanded = !!expandedFeatures[f.featureId];

            return (
              <div
                key={`${item.itemId}-${f.featureId}-${idx}`}
                className={`rounded-xl shadow-sm border relative transition-all duration-300 hover:shadow-md ${attributePalette.card}`}
              >
                <div className={`w-1.5 shrink-0 absolute left-0 top-0 bottom-0 rounded-l-xl ${attributePalette.accent}`}></div>

                <div className="p-5 pl-8 pr-6">
                  {/* Header row: source feature meta on the left, attribute selector/badges on the right */}
                  <div className="flex items-start justify-between gap-6">
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedFeatures(prev => ({
                            ...prev,
                            [f.featureId]: !prev[f.featureId],
                          }))
                        }
                        className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 hover:text-slate-700 hover:bg-slate-50 text-[10px] font-black"
                        title={isExpanded ? 'Collapse value mappings' : 'Expand value mappings'}
                      >
                        <svg
                          className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                      <div>
                        <p className={`text-sm font-black leading-tight ${attributeTone === 'mapped' ? 'text-emerald-900' : attributeTone === 'notRequired' ? 'text-amber-900' : 'text-rose-900'}`}>{f.featureId}</p>
                        <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">{f.description}</p>
                      </div>
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
                        {isLockedByMe && (hasMultipleOptions || usingClassScope) ? (
                          <SearchableSelect
                            tone={attributeTone}
                            value={selectedAttribute}
                            options={attributeOptions}
                            onChange={(val) => handleUpdateLinkage(f.featureId, val)}
                          />
                        ) : (
                          <p
                            className={`px-3 py-2 border rounded-lg text-[10px] font-black uppercase tracking-tight text-right truncate ${attributePalette.attrReadonly}`}
                          >
                            {selectedAttribute}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Per-value rows: ensure strict left/right alignment */}
                  {isExpanded && (
                    <div className="mt-4 space-y-2">
                      {f.values.map((v, vidx) => {
                        const isValueMapped = selectedAttribute !== 'UNMAPPED' && effectiveMapping?.valueMappings?.[v] !== undefined;
                        const mappedValue = isValueMapped ? effectiveMapping!.valueMappings![v] : '';
                        const valueTone: Tone = attributeTone === 'notRequired'
                          ? 'notRequired'
                          : isValueMapped
                            ? 'mapped'
                            : 'unmapped';
                        const valuePalette = toneTheme[valueTone];

                        if (showUnmappedOnly && !featureHasUnmappedAttribute && isValueMapped) {
                          return null;
                        }

                        // Look up optional legacy value description, if provided via BOM
                        const legacyDescMap = f.valueDescriptions || {};
                        const legacyDesc = legacyDescMap[v] || '';

                        // Look up optional target value description from the active class attribute
                        let targetValueDescription = '';
                        if (
                          useNewClassTargetMapping &&
                          (stagedClassId || 'UNCLASSIFIED') !== 'UNCLASSIFIED' &&
                          selectedAttribute &&
                          selectedAttribute !== 'UNMAPPED' &&
                          selectedAttribute !== 'NOT REQUIRED' &&
                          mappedValue
                        ) {
                          const activeClass = classes.find(c => c.classId === (stagedClassId || 'UNCLASSIFIED'));
                          const attrDef = activeClass?.attributes.find(a => normalizeAttrId(a.attributeId) === normalizeAttrId(selectedAttribute));
                          const descMap = attrDef?.valueDescriptions || {};
                          targetValueDescription = descMap[mappedValue] || '';
                        }

                        return (
                          <div
                            key={`${item.itemId}-${f.featureId}-row-${vidx}`}
                            className="grid grid-cols-[1fr_auto_1fr] gap-4 items-center"
                          >
                            <div className="px-3 py-2 bg-slate-900 text-white rounded-lg text-[9px] font-black uppercase tracking-tight truncate flex flex-col max-w-full">
                              <span className="truncate">{v}</span>
                              {legacyDesc && (
                                <span className="mt-0.5 text-[8px] font-normal normal-case tracking-normal text-slate-100/80 truncate" title={legacyDesc}>
                                  {legacyDesc}
                                </span>
                              )}
                            </div>

                            <div className="flex items-center justify-center text-2xl font-black text-slate-300">
                              →
                            </div>

                            <div>
                              {isReadOnly ? (
                                <div className={`px-3 py-2 rounded-lg text-[9px] font-black uppercase tracking-tight truncate ${valuePalette.valueReadonly}`}>
                                  {valueTone === 'notRequired' ? 'N/A' : mappedValue || '—'}
                                  {targetValueDescription && valueTone !== 'notRequired' && (
                                    <div className="mt-0.5 text-[8px] font-normal normal-case tracking-normal text-white/80 truncate" title={targetValueDescription}>
                                      {targetValueDescription}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className={`rounded-lg p-1 ${valuePalette.valueWrapper}`}>
                                  <ValueSelector
                                    tone={valueTone}
                                    value={mappedValue}
                                    options={candidateValuesForAttribute}
                                    disabled={isReadOnly}
                                    onChange={(newVal) => handleUpdateValue(f.featureId, v, newVal)}
                                  />
                                  {targetValueDescription && valueTone !== 'notRequired' && (
                                    <div className="mt-1 text-[8px] font-normal normal-case tracking-normal text-slate-600 truncate" title={targetValueDescription}>
                                      {targetValueDescription}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })})()}

          {useNewClassTargetMapping && unmappedTargetAttributes.length > 0 && (
            <div className="mt-4">
              <div
                className={`rounded-xl shadow-sm border relative transition-all duration-300 hover:shadow-md ${unmappedTargetPalette.card}`}
              >
                <div className={`w-1.5 shrink-0 absolute left-0 top-0 bottom-0 rounded-l-xl ${unmappedTargetPalette.accent}`}></div>

                <div className="p-5 pl-8 pr-6">
                  <div className="flex items-start justify-between gap-6">
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        onClick={() => setUnmappedTargetsExpanded(v => !v)}
                        className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 hover:text-slate-700 hover:bg-slate-50 text-[10px] font-black"
                        title={unmappedTargetsExpanded ? 'Collapse target-only attributes' : 'Expand target-only attributes'}
                      >
                        <svg
                          className={`w-3 h-3 transition-transform ${unmappedTargetsExpanded ? 'rotate-90' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                      <div>
                        <p className="text-sm font-black leading-tight text-rose-900">Target-only attributes</p>
                        <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">
                          Attributes in this class that do not have a legacy source feature.
                        </p>
                      </div>
                    </div>
                  </div>

                  {unmappedTargetsExpanded && (
                    <div className="mt-4 space-y-2">
                      {unmappedTargetAttributes.map((attr, idx) => {
                        const manualKey = `UNMAPPED::${attr.attributeId}`;
                        const rawValue = manualInputs[manualKey] || '';
                        const trimmedValue = (rawValue || '').trim();
                        const toneForManual: Tone = !trimmedValue
                          ? 'unmapped'
                          : trimmedValue === 'NOT REQUIRED'
                            ? 'notRequired'
                            : 'mapped';

                        if (showUnmappedOnly && toneForManual !== 'unmapped') {
                          return null;
                        }

                        const manualPalette = toneTheme[toneForManual];

                        return (
                          <div
                            key={`unmapped-attr-${attr.attributeId}-${idx}`}
                            className="grid grid-cols-[auto_auto_auto] gap-2 items-center"
                          >
                            <div
                              className={`px-3 py-1 border rounded-lg text-[9px] font-black uppercase tracking-tight truncate ${
                                toneForManual === 'mapped'
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                                  : toneForManual === 'notRequired'
                                    ? 'border-amber-200 bg-amber-50 text-amber-800'
                                    : 'border-rose-200 bg-rose-50 text-rose-700'
                              }`}
                            >
                              {attr.attributeId}
                            </div>

                            <div className="flex items-center justify-center text-lg font-black text-slate-300 px-1">
                              →
                            </div>

                            <div>
                              {isReadOnly ? (
                                <div
                                  className={`w-72 max-w-full px-3 py-2 rounded-lg text-[9px] font-black uppercase tracking-tight truncate ${manualPalette.valueReadonly}`}
                                >
                                  {toneForManual === 'notRequired' ? 'N/A' : trimmedValue || '—'}
                                </div>
                              ) : (
                                <div className="rounded-lg p-1 bg-white border border-slate-200 w-72 max-w-full">
                                  <ValueSelector
                                    tone={toneForManual}
                                    value={rawValue}
                                    options={(() => {
                                      let base = attributeCandidateValues[attr.attributeId] || [];
                                      if (useNewClassTargetMapping && attr.allowedValues && attr.allowedValues.length > 0) {
                                        base = attr.allowedValues;
                                      }
                                      const withNotRequired = base.includes('NOT REQUIRED') ? base : [...base, 'NOT REQUIRED'];
                                      return withNotRequired;
                                    })()}
                                    disabled={isReadOnly}
                                    onChange={(val) => handleManualInputChange(manualKey, val)}
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MappingWorkspace;
