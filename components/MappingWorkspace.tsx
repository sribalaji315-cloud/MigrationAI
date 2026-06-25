
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { LegacyItem, NewClassification, GlobalMapping, LocalItemMappings, NewAttribute, ItemLock, User, FeatureFlags, MappingTypeConfig, MLPrediction, ItemApprovalState } from '../types';
import { dbService } from '../services/dbService';

type Tone = 'mapped' | 'unmapped' | 'notRequired' | 'partial' | 'multiple';

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
  partial: {
    trigger: 'bg-orange-50 border-orange-300 text-orange-800 focus:ring-orange-400 focus:border-orange-400',
    dropdownBorder: 'border-orange-200',
    optionActive: 'bg-orange-100 text-orange-800',
    optionHover: 'hover:bg-orange-100',
    card: 'bg-orange-50/60 border-orange-200',
    accent: 'bg-orange-500',
    attrReadonly: 'border-orange-200 bg-orange-50 text-orange-800',
    valueWrapper: 'bg-orange-50 border border-orange-100',
    valueReadonly: 'bg-orange-500 text-white',
    valueInput: 'bg-orange-50 border-orange-300 text-orange-800 focus:ring-orange-300 focus:border-orange-300',
    valueButton: 'border-orange-200 text-orange-700',
  },
  multiple: {
    trigger: 'bg-violet-50 border-violet-300 text-violet-800 focus:ring-violet-400 focus:border-violet-400',
    dropdownBorder: 'border-violet-200',
    optionActive: 'bg-violet-100 text-violet-800',
    optionHover: 'hover:bg-violet-100',
    card: 'bg-violet-50/60 border-violet-200',
    accent: 'bg-violet-500',
    attrReadonly: 'border-violet-200 bg-violet-50 text-violet-800',
    valueWrapper: 'bg-violet-50 border border-violet-100',
    valueReadonly: 'bg-violet-500 text-white',
    valueInput: 'bg-violet-50 border-violet-300 text-violet-800 focus:ring-violet-300 focus:border-violet-300',
    valueButton: 'border-violet-200 text-violet-700',
  },
};

const SearchableSelect = ({ value, onChange, tone = 'mapped', featureId, classId }: { value: string, onChange: (val: string) => void, tone?: Tone, featureId: string, classId?: string | null }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<string[]>([]);
  const [globalSet, setGlobalSet] = useState<Set<string>>(new Set());
  const [warningSet, setWarningSet] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const fetchOptions = (searchQuery?: string) => {
    setLoading(true);
    dbService.fetchAttributeOptions(featureId, classId, searchQuery || undefined)
      .then(result => {
        const seen = new Set<string>();
        const ordered: string[] = ['UNMAPPED', 'NOT REQUIRED'];
        seen.add('UNMAPPED'); seen.add('NOT REQUIRED');
        const gSet = new Set<string>();
        const wSet = new Set<string>();
        const wIds = new Set((result.warningIds || []).map(w => w.toUpperCase().replace(/\s+/g, '')));
        // Global candidates first
        (result.globalCandidates || []).forEach(a => {
          if (!seen.has(a)) { seen.add(a); ordered.push(a); gSet.add(a); }
          if (wIds.has(a.toUpperCase().replace(/\s+/g, ''))) wSet.add(a);
        });
        // Then class attributes
        (result.classAttributes || []).forEach(a => {
          if (!seen.has(a)) { seen.add(a); ordered.push(a); }
        });
        // Ensure current value is in the list
        if (value && !seen.has(value) && value !== 'UNMAPPED' && value !== 'NOT REQUIRED') {
          ordered.push(value);
        }
        setOptions(ordered);
        setGlobalSet(gSet);
        setWarningSet(wSet);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  const handleOpen = () => {
    if (!isOpen) {
      setSearch('');
      fetchOptions();
    }
    setIsOpen(!isOpen);
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setSearch(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchOptions(q || undefined);
    }, 250);
  };

  return (
    <div ref={wrapperRef} className="relative mb-2">
      <div 
        className={`w-full px-3 py-2 pr-8 border-2 rounded-lg text-[10px] font-black uppercase tracking-tight cursor-pointer transition-colors outline-none flex items-center justify-between ${palette.trigger}`}
        onClick={handleOpen}
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
              onChange={handleSearchChange}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          </div>
          <div className="overflow-y-auto flex-1">
            {loading ? (
              <div className="px-3 py-3 text-[10px] font-bold text-slate-400 text-center">Loading...</div>
            ) : options.length > 0 ? options.map((opt, idx) => {
              const isPriority = globalSet.has(opt);
              const isWarning = warningSet.has(opt);
              return (
              <div
                key={idx}
                className={`px-3 py-2 text-[10px] font-black uppercase tracking-tight cursor-pointer flex items-center gap-1.5 ${isWarning ? 'bg-rose-50 text-rose-700' : isPriority ? 'bg-indigo-50' : ''} ${palette.optionHover} ${opt === value ? palette.optionActive : 'text-slate-700'}`}
                onClick={() => {
                  onChange(opt);
                  setIsOpen(false);
                }}
              >
                {opt}
                {isWarning && (
                  <span className="ml-auto px-1.5 py-0.5 bg-rose-100 text-rose-600 text-[7px] font-black rounded-full tracking-wider shrink-0">NOT IN CLASS</span>
                )}
                {isPriority && !isWarning && (
                  <span className="ml-auto px-1.5 py-0.5 bg-indigo-100 text-indigo-600 text-[7px] font-black rounded-full tracking-wider shrink-0">GLOBAL</span>
                )}
              </div>
              );
            }) : (
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
  const [searchResults, setSearchResults] = useState<{ classId: string; className: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const initialOptions = useMemo(
    () => [
      { classId: 'UNCLASSIFIED', className: 'Universal Schema' },
      ...classes.map(c => ({ classId: c.classId, className: c.className })),
    ],
    [classes]
  );

  const displayOptions = useMemo(() => {
    if (searchResults !== null) {
      return [
        { classId: 'UNCLASSIFIED', className: 'Universal Schema' },
        ...searchResults.filter(r => r.classId !== 'UNCLASSIFIED'),
      ].filter(o => {
        const q = search.toLowerCase();
        return !q || o.className.toLowerCase().includes(q) || o.classId.toLowerCase().includes(q);
      });
    }
    return initialOptions;
  }, [initialOptions, searchResults, search]);

  const selected = useMemo(() => {
    const id = value || 'UNCLASSIFIED';
    return displayOptions.find(o => o.classId === id) || initialOptions.find(o => o.classId === id) || initialOptions[0];
  }, [value, displayOptions, initialOptions]);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setSearch(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      dbService.searchClassificationNames(q.trim(), 20)
        .then(res => {
          setSearchResults(res.items || []);
          setSearching(false);
        })
        .catch(() => {
          setSearchResults([]);
          setSearching(false);
        });
    }, 250);
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setIsOpen(o => !o);
          setSearch('');
          setSearchResults(null);
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
              onChange={handleSearchChange}
              className="w-full px-2 py-1.5 text-[9px] font-bold text-slate-700 bg-white border border-slate-200 rounded outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
              placeholder="Search classes..."
              autoFocus
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {searching ? (
              <div className="px-3 py-2 text-[9px] font-bold text-slate-400 text-center">Searching...</div>
            ) : displayOptions.length > 0 ? displayOptions.map(opt => (
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
            )) : (
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

const MetaFilterDropdown = ({
  value,
  options,
  onChange,
  placeholder,
}: {
  value: string;
  options: string[];
  onChange: (val: string) => void;
  placeholder: string;
}) => {
  const [isOpen, setIsOpen] = useState(false);
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

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(o => !o)}
        className="w-36 h-7 px-2 pr-6 rounded-lg border border-slate-200 bg-white text-[9px] font-black text-slate-600 uppercase tracking-widest flex items-center justify-between shadow-sm hover:bg-slate-50"
      >
        <span className="truncate">
          {value.trim() ? value : placeholder}
        </span>
        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>

      {isOpen && (
        <div className="absolute z-40 mt-1 w-44 bg-white border border-slate-200 rounded-lg shadow-lg max-h-64 overflow-hidden">
          <div className="max-h-60 overflow-y-auto">
            <button
              type="button"
              onClick={() => {
                onChange('');
                setIsOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 text-[9px] font-black uppercase tracking-tight hover:bg-indigo-50 text-slate-400 truncate"
            >
              All
            </button>
            {options.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  onChange(opt);
                  setIsOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-[9px] font-black uppercase tracking-tight hover:bg-indigo-50 truncate ${
                  value === opt ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'
                }`}
              >
                {opt}
              </button>
            ))}
            {options.length === 0 && (
              <div className="px-3 py-2 text-[9px] font-bold text-slate-400 text-center">No data</div>
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
  mappingTypeConfig?: MappingTypeConfig;
  localItemMappings: LocalItemMappings;
  assignedClassId?: string | null;
  isLockedByMe: boolean;
  lockOwner: ItemLock | null;
  currentUser: User;
  featureFlags: FeatureFlags;
  onToggleNewClassTargetMapping: (forceValue?: boolean) => void;
  onSignOn: () => Promise<void>;
  onSignOff: () => Promise<void>;
  onSaveChanges: (updates: any) => Promise<void>;
  onSyncFromDB: () => void;
  onRevertItem?: (itemId: string) => Promise<void>;
  isGenerationActive: boolean;
}

const MappingWorkspace: React.FC<MappingWorkspaceProps> = ({ 
  item, 
  classes, 
  globalMappings, 
  mappingTypeConfig,
  localItemMappings, 
  assignedClassId,
  isLockedByMe,
  lockOwner,
  currentUser,
  featureFlags,
  onToggleNewClassTargetMapping,
  onSignOn,
  onSignOff,
  onSaveChanges,
  onSyncFromDB,
  onRevertItem,
  isGenerationActive
}) => {
  const { useNewClassTargetMapping } = featureFlags;
  const normalizeAttrId = (id: string) => (id || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const normalizeMappingType = (value?: string | null) => (value || '').trim().toLowerCase();
  const canEdit = isLockedByMe && !isGenerationActive;

  // Resolve a legacy value against a valueMappings dictionary.
  // Tries the exact key first; if that yields an empty/missing result, falls back
  // to the short-code prefix (text before the first space) which may carry a real
  // target value (e.g. "TR00F" -> "MET0073" when the BOM value is "TR00F Black").
  const resolveValueMapping = (valueMappings: Record<string, string> | undefined, legacyValue: string): string | undefined => {
    if (!valueMappings) return undefined;
    const exact = valueMappings[legacyValue];
    if (exact !== undefined && exact !== '') return exact;
    const spaceIdx = legacyValue.indexOf(' ');
    if (spaceIdx > 0) {
      const prefix = legacyValue.substring(0, spaceIdx);
      const prefixVal = valueMappings[prefix];
      if (prefixVal !== undefined && prefixVal !== '') return prefixVal;
    }
    return exact; // may be '' or undefined
  };

  const hasResolvedValueMapping = (resolvedValue: string | undefined): boolean => {
    return typeof resolvedValue === 'string' && resolvedValue.trim() !== '';
  };

  const includedMappingTypeSet = useMemo(() => {
    const available = (mappingTypeConfig?.availableTypes || []).map(normalizeMappingType).filter(Boolean);
    const included = (mappingTypeConfig?.includedTypes || []).map(normalizeMappingType).filter(Boolean);
    if (!available.length) return null;
    return new Set(included.length ? included : available);
  }, [mappingTypeConfig]);
  const allGlobalMappingsByFeature = useMemo(() => {
    const byFeature: Record<string, GlobalMapping> = {};
    (globalMappings || []).forEach(m => {
      (m.legacyFeatureIds || []).forEach(fid => {
        if (fid && !byFeature[fid]) {
          byFeature[fid] = m;
        }
      });
    });
    return byFeature;
  }, [globalMappings]);
  const engineeringGlobalMappings = useMemo(
    () => {
      const includedSet = includedMappingTypeSet;
      return (globalMappings || []).filter(m => {
        const attrType = normalizeMappingType(m.attributeType);
        if (!includedSet) {
          return !!attrType;
        }
        return includedSet.has(attrType);
      });
    },
    [globalMappings, includedMappingTypeSet]
  );
  const [manualInputs, setManualInputs] = useState<Record<string, string>>({});
  const [stagedLocalMappings, setStagedLocalMappings] = useState<GlobalMapping[]>([]);
  const [stagedClassId, setStagedClassId] = useState<string | null>(null);
  const [mlPredicting, setMlPredicting] = useState(false);
  const [mlPredictions, setMlPredictions] = useState<MLPrediction[]>([]);
  const [legacyFilter, setLegacyFilter] = useState('');
  const [showUnmappedOnly, setShowUnmappedOnly] = useState(false);
  const [feasibilityFilter, setFeasibilityFilter] = useState('');
  const [valueStatusFilter, setValueStatusFilter] = useState('');
  const [expandedFeatures, setExpandedFeatures] = useState<Record<string, boolean>>({});
  const [unmappedTargetsExpanded, setUnmappedTargetsExpanded] = useState(true);
  // Migration approval state (item-level flag + per-feature approvals)
  const [approvalState, setApprovalState] = useState<ItemApprovalState | null>(null);
  const approvalFetchRef = useRef<string | null>(null);
  const isEditingRef = useRef(false);
  const prevItemIdRef = useRef<string | null>(null);
  const previousClassIdRef = useRef<string | null>(null);

  // On-demand fetched classifications (keyed by classId)
  const [fetchedClasses, setFetchedClasses] = useState<Record<string, NewClassification>>({});
  const fetchingClassRef = useRef<string | null>(null);

  // Merge prop classes with on-demand fetched classes
  const mergedClasses = useMemo(() => {
    const byId = new Map<string, NewClassification>();
    classes.forEach(c => byId.set(c.classId, c));
    Object.values(fetchedClasses).forEach(c => { if (!byId.has(c.classId)) byId.set(c.classId, c); });
    return Array.from(byId.values());
  }, [classes, fetchedClasses]);

  // Fetch class on demand when stagedClassId isn't in the preloaded set
  useEffect(() => {
    const classId = stagedClassId;
    if (!classId || classId === 'UNCLASSIFIED') return;
    // Already available in props or fetched cache
    if (classes.some(c => c.classId === classId) || fetchedClasses[classId]) return;
    // Already fetching this one
    if (fetchingClassRef.current === classId) return;
    fetchingClassRef.current = classId;
    dbService.fetchClassification(classId)
      .then(cls => {
        if (fetchingClassRef.current !== classId) return;
        setFetchedClasses(prev => ({ ...prev, [classId]: cls }));
      })
      .catch(err => console.warn(`Failed to fetch classification '${classId}':`, err))
      .finally(() => { if (fetchingClassRef.current === classId) fetchingClassRef.current = null; });
  }, [stagedClassId, classes, fetchedClasses]);

  // Per-item global mapping candidates fetched from the API
  const [globalByFeatureMap, setGlobalByFeatureMap] = useState<Record<string, GlobalMapping[]>>({});
  const globalByFeatureFetchRef = useRef<string | null>(null);

  useEffect(() => {
    if (!item) { setGlobalByFeatureMap({}); return; }
    const featureIds = item.features.map(f => f.featureId);
    if (featureIds.length === 0) { setGlobalByFeatureMap({}); return; }
    const key = `${item.itemId}::${featureIds.join(',')}`;
    if (globalByFeatureFetchRef.current === key) return;
    globalByFeatureFetchRef.current = key;
    dbService.fetchGlobalMappingsByFeatures(featureIds)
      .then(result => {
        if (globalByFeatureFetchRef.current !== key) return;
        setGlobalByFeatureMap(result);
      })
      .catch(err => console.warn('Failed to fetch global mappings by features', err));
  }, [item]);

  // Initialize workspace when item changes
  useEffect(() => {
    if (item) {
      const itemChanged = prevItemIdRef.current !== item.itemId;
      prevItemIdRef.current = item.itemId;

      isEditingRef.current = false;
      setStagedClassId(assignedClassId || 'UNCLASSIFIED');
      previousClassIdRef.current = assignedClassId || null;
      setMlPredictions(item.mlPredictions || []);
      setStagedLocalMappings(
        JSON.parse(JSON.stringify(localItemMappings[item.itemId] || [])).map((m: GlobalMapping) => ({
          ...m,
          attributeType: m.attributeType || '',
        }))
      );
      // Fetch class attribute values from dedicated table
      dbService.getClassAttributeValues(item.itemId)
        .then(({ values }) => {
          const nextManual: Record<string, string> = {};
          Object.entries(values || {}).forEach(([attrId, val]) => {
            if (val !== undefined && val !== null && String(val).trim() !== '') {
              nextManual[`UNMAPPED::${attrId}`] = String(val);
            }
          });
          setManualInputs(nextManual);
        })
        .catch(() => setManualInputs({}));
      // Only reset UI view state when switching to a different item
      if (itemChanged) {
        setLegacyFilter('');
        setShowUnmappedOnly(false);
        setFeasibilityFilter('');
        setValueStatusFilter('');
        setExpandedFeatures({});
        // Auto-enable class view when item has an assigned class
        if (assignedClassId && assignedClassId !== 'UNCLASSIFIED') {
          onToggleNewClassTargetMapping(true);
        }
      }
    } else {
      prevItemIdRef.current = null;
      isEditingRef.current = false;
      setStagedClassId(null);
      previousClassIdRef.current = null;
      setMlPredictions([]);
      setStagedLocalMappings([]);
      setManualInputs({});
      setLegacyFilter('');
      setShowUnmappedOnly(false);
      setFeasibilityFilter('');
      setValueStatusFilter('');
      setExpandedFeatures({});
    }
  }, [item, assignedClassId, localItemMappings]);

  const handleManualInputChange = (key: string, value: string) => {
    if (!canEdit) return;
    isEditingRef.current = true;
    setManualInputs(prev => ({ ...prev, [key]: value }));
  };

  const handlePredictSingle = async () => {
    if (!item) return;
    setMlPredicting(true);
    try {
      const result = await dbService.predictClassification(item.itemId);
      setMlPredictions(result.predictions || []);
    } catch (err) {
      console.error('ML prediction failed:', err);
    } finally {
      setMlPredicting(false);
    }
  };

  const handlePickPrediction = (classId: string) => {
    isEditingRef.current = true;
    setStagedClassId(classId);
  };

  const commitToSystem = async () => {
    if (!item) return;
    if (!canEdit) {
      alert('Mapping generation is running. Editing and save are temporarily disabled.');
      return;
    }
    const classId = stagedClassId || 'UNCLASSIFIED';
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

    // Save classification directly to bom_items table
    await dbService.assignClassification(item.itemId, classId);

    if (useNewClassTargetMapping) {
      // Save class attribute values to dedicated table
      await dbService.saveClassAttributeValues(
        item.itemId,
        classId,
        previousClassIdRef.current,
        manualForItem,
      );
    } else {
      // Legacy view — remove any stored class attribute values for this item
      await dbService.deleteClassAttributeValues(item.itemId);
    }
    previousClassIdRef.current = classId;

    // Save local mappings + update in-memory classification via the existing onSaveChanges path
    await onSaveChanges({
      localMappings: { [item.itemId]: stagedLocalMappings },
      itemClassifications: { [item.itemId]: classId },
    });
    isEditingRef.current = false;

    // Auto-enable class view after saving with an assigned class
    if (classId !== 'UNCLASSIFIED') {
      onToggleNewClassTargetMapping(true);
    }
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

  const handleRevertItemToGlobal = async () => {
    if (!item) return;
    if (!confirm(`Revert all local overrides for "${item.itemId}" to global mappings? This cannot be undone.`)) return;
    try {
      await dbService.revertItemToGlobal(item.itemId);
      if (onRevertItem) {
        await onRevertItem(item.itemId);
      } else {
        onSyncFromDB();
      }
    } catch (e: any) {
      alert(`Revert failed: ${e.message}`);
    }
  };

  // --- Migration approval --------------------------------------------------
  // Fetch approval state whenever the selected item changes.
  useEffect(() => {
    if (!item) {
      approvalFetchRef.current = null;
      setApprovalState(null);
      return;
    }
    const key = item.itemId;
    approvalFetchRef.current = key;
    dbService.fetchItemApprovalState(item.itemId)
      .then(state => { if (approvalFetchRef.current === key) setApprovalState(state); })
      .catch(() => { if (approvalFetchRef.current === key) setApprovalState(null); });
  }, [item?.itemId]);

  // Locally clear approval for an edited feature (and the item flag). The
  // server performs the authoritative reset on save (PUT).
  const clearApprovalForFeatureLocally = (featureId: string) => {
    setApprovalState(prev => {
      if (!prev) return prev;
      if (!prev.features[featureId] && !prev.itemApproved) return prev;
      const features = { ...prev.features };
      delete features[featureId];
      return { ...prev, itemApproved: false, approvedByUsername: null, approvedAt: null, features };
    });
  };

  const handleToggleFeatureApproval = async (featureId: string) => {
    if (!item || !isLockedByMe) return;
    const currentlyApproved = !!approvalState?.features?.[featureId];
    try {
      const next = await dbService.setFeatureApproval(item.itemId, featureId, !currentlyApproved);
      setApprovalState(next);
    } catch (e: any) {
      alert(`Approval failed: ${e.message}`);
    }
  };

  const handleToggleItemApproval = async () => {
    if (!item || !isLockedByMe) return;
    const currentlyApproved = !!approvalState?.itemApproved;
    try {
      // Persist any pending edits first so approval reflects saved mappings
      // (saving resets approval server-side, so this must precede approval).
      if (!currentlyApproved && isEditingRef.current) {
        await commitToSystem();
      }
      const next = await dbService.setItemApproval(item.itemId, !currentlyApproved);
      setApprovalState(next);
    } catch (e: any) {
      alert(`Approval failed: ${e.message}`);
    }
  };

  const handleDiscardSessionChanges = () => {
    if (!item) return;
    if (confirm("Discard all unsaved changes for this session?")) {
      isEditingRef.current = false;
      setStagedClassId(assignedClassId || 'UNCLASSIFIED');
      setStagedLocalMappings(
        JSON.parse(JSON.stringify(localItemMappings[item.itemId] || [])).map((m: GlobalMapping) => ({
          ...m,
          attributeType: m.attributeType || '',
        }))
      );
      dbService.getClassAttributeValues(item.itemId)
        .then(({ values }) => {
          const nextManual: Record<string, string> = {};
          Object.entries(values || {}).forEach(([attrId, val]) => {
            if (val !== undefined && val !== null && String(val).trim() !== '') {
              nextManual[`UNMAPPED::${attrId}`] = String(val);
            }
          });
          setManualInputs(nextManual);
        })
        .catch(() => setManualInputs({}));
    }
  };

  const handleResetToGlobal = (featureId: string) => {
    if (!canEdit) return;
    isEditingRef.current = true;
    setStagedLocalMappings(prev => prev.filter(m => !m.legacyFeatureIds.includes(featureId)));
  };

  const allSystemAttributes = useMemo(() => {
    const attrMap = new Map<string, NewAttribute & { sourceClass?: string }>();
    mergedClasses.forEach(c => {
      c.attributes.forEach(a => {
        if (!attrMap.has(a.attributeId)) {
          attrMap.set(a.attributeId, { ...a, sourceClass: c.className });
        }
      });
    });
    return Array.from(attrMap.values());
  }, [mergedClasses]);

  const targetAttributes = useMemo(() => {
    const classId = stagedClassId || 'UNCLASSIFIED';
    let attrs: NewAttribute[] = [];
    if (classId === 'UNCLASSIFIED') {
      attrs = [...allSystemAttributes];
    } else {
      const selectedClass = mergedClasses.find(c => c.classId === classId);
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
  }, [stagedClassId, mergedClasses, allSystemAttributes]);

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
    engineeringGlobalMappings.forEach(m => {
      const attrId = m.newAttributeId;
      if (!attrId) return;
      if (!byAttr[attrId]) byAttr[attrId] = [];
      Object.values(m.valueMappings || {}).forEach(val => {
        if (!val) return;
        if (!byAttr[attrId].includes(val)) byAttr[attrId].push(val);
      });
    });

    // Merge in classification allowedValues, if present
    mergedClasses.forEach(cls => {
      cls.attributes.forEach(attr => {
        if (!attr.allowedValues || attr.allowedValues.length === 0) return;
        const list = (byAttr[attr.attributeId] = byAttr[attr.attributeId] || []);
        attr.allowedValues.forEach(v => {
          if (!list.includes(v)) list.push(v);
        });
      });
    });

    return byAttr;
  }, [engineeringGlobalMappings, mergedClasses]);

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

  const metaFilterOptions = useMemo(() => {
    if (!item) return { feasibility: [] as string[], valueStatus: [] as string[] };

    const globalByFeature: Record<string, GlobalMapping[]> = {};
    engineeringGlobalMappings.forEach(m => {
      m.legacyFeatureIds.forEach(fid => {
        if (!globalByFeature[fid]) globalByFeature[fid] = [];
        globalByFeature[fid].push(m);
      });
    });

    const localByFeature: Record<string, any> = {};
    stagedLocalMappings.forEach(m => {
      m.legacyFeatureIds.forEach(fid => {
        localByFeature[fid] = m;
      });
    });

    const feasibilitySet = new Set<string>();
    const valueStatusSet = new Set<string>();

    item.features.forEach(f => {
      const localOverride = localByFeature[f.featureId];
      const globalMappingsForFeature = globalByFeatureMap[f.featureId] || globalByFeature[f.featureId] || [];
      const effectiveMapping = localOverride || globalMappingsForFeature[0] || null;
      f.values.forEach(v => {
        const vm = effectiveMapping?.valueMeta?.[v];
        if (vm?.feasibility) feasibilitySet.add(vm.feasibility);
        if (vm?.valueStatus) valueStatusSet.add(vm.valueStatus);
      });
    });

    return {
      feasibility: Array.from(feasibilitySet).sort((a, b) => a.localeCompare(b)),
      valueStatus: Array.from(valueStatusSet).sort((a, b) => a.localeCompare(b)),
    };
  }, [item, engineeringGlobalMappings, stagedLocalMappings, globalByFeatureMap]);

  const unmappedStats = useMemo(() => {
    if (!item) return { attributes: 0, values: 0, totalAttributes: 0, totalValues: 0 };

    let attrCount = 0;
    let valueCount = 0;
    let totalAttrCount = 0;
    let totalValueCount = 0;

    const globalByFeature: Record<string, GlobalMapping[]> = {};
    engineeringGlobalMappings.forEach(m => {
      m.legacyFeatureIds.forEach(fid => {
        if (!globalByFeature[fid]) globalByFeature[fid] = [];
        globalByFeature[fid].push(m);
      });
    });

    const localByFeature: Record<string, any> = {};
    stagedLocalMappings.forEach(m => {
      m.legacyFeatureIds.forEach(fid => {
        localByFeature[fid] = m;
      });
    });

    item.features.forEach(f => {
      const globalMappingsForFeature = globalByFeature[f.featureId] || [];
      const globalMapping = globalMappingsForFeature[0] || null;
      const localOverride = localByFeature[f.featureId];
      const fallbackGlobal = allGlobalMappingsByFeature[f.featureId];
      // Use global mapping's attributeType for type filtering (workspace mappings have empty attributeType)
      const effectiveType = normalizeMappingType(fallbackGlobal?.attributeType);
      if (includedMappingTypeSet && effectiveType && !includedMappingTypeSet.has(effectiveType)) {
        return;
      }

      totalAttrCount += 1;
      totalValueCount += f.values.length;

      // Collect target attributes from ALL global mappings for this feature
      let attributeOptions: string[] = [];
      globalMappingsForFeature.forEach(gm => {
        const parts = (gm.newAttributeId || '').replace(/\s+/g, '').split(';').map(a => a.trim()).filter(a => a && a !== 'UNMAPPED');
        attributeOptions.push(...parts);
      });
      attributeOptions = Array.from(new Set(attributeOptions));

      let defaultGlobalAttribute = attributeOptions.length > 0 ? attributeOptions[0] : 'UNMAPPED';

      const usingClassScope = useNewClassTargetMapping && (stagedClassId || 'UNCLASSIFIED') !== 'UNCLASSIFIED';

      if (usingClassScope) {
        const matchedForClass = attributeOptions.filter(a => {
          const key = normalizeAttrId(a);
          return key && classAttributeKeys.has(key);
        });

        if (matchedForClass.length > 0) {
          defaultGlobalAttribute = matchedForClass[0];
        }
      }

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
      const effectiveMapping = localOverride
        || globalMappingsForFeature.find(gm => {
             const parts = (gm.newAttributeId || '').replace(/\s+/g, '').split(';').map(a => a.trim());
             return parts.some(p => normalizeAttrId(p) === normalizeAttrId(selectedAttribute));
           })
        || globalMapping;

      if (selectedAttribute === 'UNMAPPED') {
        attrCount += 1;
      }

      f.values.forEach(v => {
        const resolved = resolveValueMapping(effectiveMapping?.valueMappings, v);
        const isValueMapped = selectedAttribute !== 'UNMAPPED' && hasResolvedValueMapping(resolved);
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
  }, [item, engineeringGlobalMappings, stagedLocalMappings, targetAttributes, includedMappingTypeSet, allGlobalMappingsByFeature]);

  const ignoredFeatureIds = useMemo(() => {
    const ignored = new Set<string>();
    if (!item || !includedMappingTypeSet) return ignored;

    const localByFeature: Record<string, GlobalMapping> = {};
    stagedLocalMappings.forEach(m => {
      (m.legacyFeatureIds || []).forEach(fid => {
        localByFeature[fid] = m;
      });
    });

    item.features.forEach(feature => {
      // Use workspace mapping table's attributeType (set during generation) as the source of truth
      const local = localByFeature[feature.featureId];
      const attrType = normalizeMappingType(local?.attributeType);
      // Blank/empty attribute type → keep as uncategorized (not ignored).
      // Non-blank attribute type that is NOT in the included set → ignored.
      if (attrType && !includedMappingTypeSet.has(attrType)) {
        ignored.add(feature.featureId);
      }
    });

    return ignored;
  }, [item, stagedLocalMappings, allGlobalMappingsByFeature, includedMappingTypeSet]);

  const ignoredFeatures = useMemo(() => {
    if (!item) return [] as LegacyItem['features'];
    return item.features.filter(feature => ignoredFeatureIds.has(feature.featureId));
  }, [item, ignoredFeatureIds]);

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

    const globalByFeature: Record<string, GlobalMapping[]> = {};
    engineeringGlobalMappings.forEach(m => {
      m.legacyFeatureIds.forEach(fid => {
        if (!globalByFeature[fid]) globalByFeature[fid] = [];
        globalByFeature[fid].push(m);
      });
    });

    const localByFeature: Record<string, any> = {};
    stagedLocalMappings.forEach(m => {
      m.legacyFeatureIds.forEach(fid => {
        localByFeature[fid] = m;
      });
    });

    item.features.forEach(f => {
      const globalMappingsForFeature = globalByFeature[f.featureId] || [];
      const localOverride = localByFeature[f.featureId];

      let parts: string[] = [];
      globalMappingsForFeature.forEach(gm => {
        const p = (gm.newAttributeId || '').replace(/\s+/g, '').split(';').map(a => a.trim()).filter(a => a && a !== 'UNMAPPED');
        parts.push(...p);
      });
      parts = Array.from(new Set(parts));
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
  }, [item, useNewClassTargetMapping, stagedClassId, engineeringGlobalMappings, stagedLocalMappings, targetAttributes]);

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
    if (!canEdit) return;
    if (!item) return;
    isEditingRef.current = true;
    clearApprovalForFeatureLocally(featureId);

    // Precompute feature values so we can auto-populate NOT REQUIRED mappings
    const feature = item.features.find(f => f.featureId === featureId);
    const featureValues = feature?.values || [];

    setStagedLocalMappings(prev => {
      const existingLocal = prev.find(m => m.legacyFeatureIds.includes(featureId));
      const filtered = prev.filter(m => !m.legacyFeatureIds.includes(featureId));
      const globalRef = engineeringGlobalMappings.find(m => m.legacyFeatureIds.includes(featureId));

      if (attrId === 'UNMAPPED' && !globalRef) {
        return filtered;
      }

      // Current effective mapping = what the user was looking at before this change.
      // This is the source of truth for NOT REQUIRED values that must be preserved.
      const currentEffective = existingLocal || globalRef;
      const currentValueMappings = currentEffective?.valueMappings || {};

      // New attribute's global mapping = source for eligible value mappings
      // when switching to a different target attribute.
      const globalMappingsForFeature = globalByFeatureMap[featureId] || [];
      const newAttrGlobal = globalMappingsForFeature.find(gm => {
        const parts = (gm.newAttributeId || '').replace(/\s+/g, '').split(';').map(a => a.trim());
        return parts.some(p => normalizeAttrId(p) === normalizeAttrId(attrId));
      });
      const newAttrValueMappings = newAttrGlobal?.valueMappings || {};

      let nextValueMappings: Record<string, string> = {};

      if (attrId === 'NOT REQUIRED') {
        featureValues.forEach(v => {
          nextValueMappings[v] = 'NOT REQUIRED';
        });
      } else {
        // 1. NOT REQUIRED values from current mapping are ALWAYS preserved
        //    regardless of which target attribute is selected.
        // 2. For other values, use the new attribute's global mapping if available,
        //    otherwise leave empty (backend auto-populates on save).
        featureValues.forEach(v => {
          const currentVal = resolveValueMapping(currentValueMappings, v);
          if (currentVal === 'NOT REQUIRED') {
            nextValueMappings[v] = 'NOT REQUIRED';
          } else {
            const newVal = resolveValueMapping(newAttrValueMappings, v);
            if (newVal !== undefined && newVal !== '') {
              nextValueMappings[v] = newVal;
            }
          }
        });
      }

      // Preserve attribute type: prefer existing local, then any global for this feature, then globalRef
      const preservedAttrType = existingLocal?.attributeType
        || newAttrGlobal?.attributeType
        || globalRef?.attributeType
        || (globalMappingsForFeature[0]?.attributeType)
        || '';

      // Preserve per-value metadata (condition/feasibility/valueStatus) so it stays
      // visible while the user is editing. It is keyed by legacy value and is
      // independent of the chosen target attribute.
      const preservedValueMeta = existingLocal?.valueMeta || globalRef?.valueMeta;

      return [
        ...filtered,
        {
          legacyFeatureIds: [featureId],
          newAttributeId: attrId,
          attributeType: preservedAttrType,
          valueMappings: nextValueMappings,
          valueMeta: preservedValueMeta,
          mappedFrom: 'local' as const,
        },
      ];
    });
  };

  const handleUpdateValue = (featureId: string, legacyVal: string, newVal: string) => {
    if (!canEdit) return;
    isEditingRef.current = true;
    clearApprovalForFeatureLocally(featureId);
    setStagedLocalMappings(prev => {
      const next = [...prev];
      let idx = next.findIndex(m => m.legacyFeatureIds.includes(featureId));
      if (idx === -1) {
        const globalRef = engineeringGlobalMappings.find(m => m.legacyFeatureIds.includes(featureId));
        next.push({
          legacyFeatureIds: [featureId],
          newAttributeId: globalRef?.newAttributeId || '',
          attributeType: globalRef?.attributeType || '',
          valueMappings: globalRef ? { ...globalRef.valueMappings, [legacyVal]: newVal } : { [legacyVal]: newVal },
          valueMeta: globalRef?.valueMeta,
          mappedFrom: 'local' as const,
        });
      } else {
        const existingMapping = next[idx];
        if (existingMapping.legacyFeatureIds.length > 1) {
          const otherFeatures = existingMapping.legacyFeatureIds.filter(id => id !== featureId);
          next[idx] = { ...existingMapping, legacyFeatureIds: otherFeatures };
          next.push({
            legacyFeatureIds: [featureId],
            newAttributeId: existingMapping.newAttributeId,
            attributeType: existingMapping.attributeType || '',
            valueMappings: { ...existingMapping.valueMappings, [legacyVal]: newVal },
            valueMeta: existingMapping.valueMeta,
            mappedFrom: 'local' as const,
          });
        } else {
          next[idx] = { ...existingMapping, valueMappings: { ...existingMapping.valueMappings, [legacyVal]: newVal }, mappedFrom: 'local' as const };
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

  const isReadOnly = !canEdit;
  const isGenerationBlocked = isGenerationActive && isLockedByMe;
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
                   {isGenerationBlocked ? 'Mapping generation in progress - editing temporarily disabled' : isLockedByMe ? (isDirty ? 'Unsaved overrides detected' : 'Synchronized with defaults') : lockOwner ? 'Wait for release to modify' : 'Sign on to enable edits'}
                </p>
             </div>
             {item && (
               <div className={`ml-4 flex items-center gap-3 text-[9px] font-bold ${isLockedByMe || lockOwner ? 'text-white/70' : 'text-slate-500'}`}>
                 <span className="border-l border-current/20 pl-3">{item.itemId}</span>
                 {item.category && <span className="border-l border-current/20 pl-3">{item.category}</span>}
                 {item.productType && <span className="border-l border-current/20 pl-3">{item.productType}</span>}
               </div>
             )}
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
                   onClick={() => onToggleNewClassTargetMapping()}
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
                 classes={mergedClasses}
                 disabled={isReadOnly}
                 onChange={(classId) => {
                   isEditingRef.current = true;
                   setStagedClassId(classId);
                 }}
               />
               {/* ML Predictions quick-pick */}
               <div className="flex items-center gap-1.5 mt-1">
                 <button
                   type="button"
                   onClick={handlePredictSingle}
                   disabled={isReadOnly || mlPredicting || !item}
                   className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[7px] font-black uppercase tracking-widest transition-colors ${
                     mlPredicting
                       ? 'bg-violet-100 border-violet-200 text-violet-400 cursor-wait animate-pulse'
                       : 'bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100'
                   }`}
                   title="Run ML prediction for this item"
                 >
                   <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                     <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                   </svg>
                   {mlPredicting ? 'Predicting...' : 'Predict'}
                 </button>
                 {mlPredictions.length > 0 && mlPredictions.map((pred, i) => (
                   <button
                     key={pred.classId + i}
                     type="button"
                     disabled={isReadOnly}
                     onClick={() => handlePickPrediction(pred.classId)}
                     className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full border text-[7px] font-black uppercase tracking-widest transition-colors ${
                       stagedClassId === pred.classId
                         ? 'bg-violet-600 border-violet-500 text-white'
                         : 'bg-white border-violet-200 text-violet-700 hover:bg-violet-50'
                     }`}
                     title={`${pred.className}: ${Math.round(pred.confidence * 100)}% confidence`}
                   >
                     <span className="truncate max-w-[80px]">{pred.className}</span>
                     <span className={`text-[6px] ${stagedClassId === pred.classId ? 'text-violet-200' : 'text-violet-400'}`}>{Math.round(pred.confidence * 100)}%</span>
                   </button>
                 ))}
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
                  <button type="button" onClick={handleRevertItemToGlobal} disabled={isGenerationBlocked} className={`px-3 py-1.5 text-[9px] font-black rounded-lg transition-all uppercase tracking-widest ${isGenerationBlocked ? 'bg-white/5 text-white/30 cursor-not-allowed' : 'bg-amber-500/20 border border-amber-400/40 text-amber-200 hover:bg-amber-500/30'}`}>
                    Revert to Global
                  </button>
                  <button type="button" onClick={handleDiscardSessionChanges} disabled={!isDirty || isGenerationBlocked} className={`px-3 py-1.5 text-[9px] font-black rounded-lg transition-all uppercase tracking-widest ${isDirty && !isGenerationBlocked ? 'bg-white/10 border border-white/20 text-white hover:bg-white/20' : 'bg-white/5 text-white/30 cursor-not-allowed'}`}>
                    Reset
                  </button>
                  <button
                    type="button"
                    disabled={isGenerationBlocked}
                    onClick={() => commitToSystem().catch(e => console.error("Save failed:", e))}
                    className={`px-4 py-1.5 text-[9px] font-black rounded-lg transition-all shadow-md uppercase tracking-widest ${
                      isGenerationBlocked
                        ? 'bg-slate-200 text-slate-500 cursor-not-allowed shadow-none'
                        : 'bg-white text-indigo-700 hover:bg-indigo-50'
                    }`}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    disabled={isGenerationBlocked}
                    onClick={() => handleToggleItemApproval().catch(e => console.error("Approval failed:", e))}
                    title={approvalState?.itemApproved && approvalState?.approvedByUsername
                      ? `Approved for migration by ${approvalState.approvedByUsername}${approvalState.approvedAt ? ' · ' + new Date(approvalState.approvedAt * 1000).toLocaleString() : ''} — click to revoke`
                      : 'Approve this item for migration (approves all its features)'}
                    className={`px-4 py-1.5 text-[9px] font-black rounded-lg transition-all shadow-md uppercase tracking-widest inline-flex items-center gap-1.5 ${
                      isGenerationBlocked
                        ? 'bg-slate-200 text-slate-500 cursor-not-allowed shadow-none'
                        : approvalState?.itemApproved
                          ? 'bg-emerald-500 text-white hover:bg-emerald-600 border border-emerald-300'
                          : 'bg-emerald-600 text-white hover:bg-emerald-700 border border-emerald-400'
                    }`}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                    {approvalState?.itemApproved ? 'Approved' : 'Approve for Migration'}
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

                  {metaFilterOptions.feasibility.length > 0 && (
                    <MetaFilterDropdown
                      value={feasibilityFilter}
                      options={metaFilterOptions.feasibility}
                      onChange={(val) => setFeasibilityFilter(val)}
                      placeholder="Feasibility..."
                    />
                  )}

                  {metaFilterOptions.valueStatus.length > 0 && (
                    <MetaFilterDropdown
                      value={valueStatusFilter}
                      options={metaFilterOptions.valueStatus}
                      onChange={(val) => setValueStatusFilter(val)}
                      placeholder="Value status..."
                    />
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
            const globalByFeature: Record<string, GlobalMapping[]> = {};
            engineeringGlobalMappings.forEach(m => {
              m.legacyFeatureIds.forEach(fid => {
                if (!globalByFeature[fid]) globalByFeature[fid] = [];
                globalByFeature[fid].push(m);
              });
            });

            const localByFeature: Record<string, any> = {};
            stagedLocalMappings.forEach(m => {
              m.legacyFeatureIds.forEach(fid => {
                localByFeature[fid] = m;
              });
            });

            // --- Group features by attribute type from workspace mapping table ---
            const typeGroups: Record<string, typeof item.features> = {};
            item.features.forEach(f => {
              if (ignoredFeatureIds.has(f.featureId)) return;
              // Use workspace mapping table's attributeType as the source of truth
              const localForType = localByFeature[f.featureId];
              const attrType = normalizeMappingType(localForType?.attributeType) || 'uncategorized';
              if (!typeGroups[attrType]) typeGroups[attrType] = [];
              typeGroups[attrType].push(f);
            });
            const sortedTypes = Object.keys(typeGroups).sort((a, b) => {
              if (a === 'uncategorized') return 1;
              if (b === 'uncategorized') return -1;
              return a.localeCompare(b);
            });

            return sortedTypes.map(typeKey => {
              const groupFeatures = typeGroups[typeKey];
              const groupLabel = typeKey === 'uncategorized' ? 'Uncategorized' : typeKey.toUpperCase();

              const renderedCards = groupFeatures.map((f, idx) => {
              // Find ALL global mappings for this feature — use the per-item API result
              const globalMappingsForFeature = globalByFeatureMap[f.featureId] || globalByFeature[f.featureId] || [];
              const globalMapping = globalMappingsForFeature[0] || null;
              const localOverride = localByFeature[f.featureId];

            // Collect target attributes from ALL global mappings for this feature
            // sourced from the per-item by-features API call.
            let globalCandidates: string[] = [];
            globalMappingsForFeature.forEach(gm => {
              const parts = (gm.newAttributeId || '').replace(/\s+/g, '').split(';').map(a => a.trim()).filter(a => a && a !== 'UNMAPPED');
              globalCandidates.push(...parts);
            });
            globalCandidates = Array.from(new Set(globalCandidates));

            const usingClassScope = useNewClassTargetMapping && (stagedClassId || 'UNCLASSIFIED') !== 'UNCLASSIFIED';

            let defaultGlobalAttribute = globalCandidates.length > 0 ? globalCandidates[0] : 'UNMAPPED';

            // When using class scope, prefer a global candidate that also exists in the class
            if (usingClassScope) {
              const matchedForClass = globalCandidates.filter(a => {
                const key = normalizeAttrId(a);
                return key && classAttributeKeys.has(key);
              });
              if (matchedForClass.length > 0) {
                defaultGlobalAttribute = matchedForClass[0];
              }
            }

            // Always show the dropdown when the item is locked (server handles search)
            const hasMultipleOptions = globalCandidates.length > 1;

            // The currently selected attribute is the local override, OR the default global attribute
            let selectedAttribute = localOverride?.newAttributeId || defaultGlobalAttribute;

            if (usingClassScope) {
              const selectedKey = normalizeAttrId(selectedAttribute);
              const isGlobalCandidate = globalCandidates.some(gc => normalizeAttrId(gc) === selectedKey);
              if (
                selectedAttribute &&
                selectedAttribute !== 'UNMAPPED' &&
                selectedAttribute !== 'NOT REQUIRED' &&
                !isGlobalCandidate &&
                (!selectedKey || !classAttributeKeys.has(selectedKey))
              ) {
                selectedAttribute = 'UNMAPPED';
              }
            }

            // It has a mapping if the selected attribute is not 'UNMAPPED'
            const hasMapping = selectedAttribute !== 'UNMAPPED';

            // Find the effective mapping for value resolution: local override takes priority,
            // otherwise find the global mapping whose target matches the selected attribute.
            const effectiveMapping = localOverride
              || globalMappingsForFeature.find(gm => {
                   const parts = (gm.newAttributeId || '').replace(/\s+/g, '').split(';').map(a => a.trim());
                   return parts.some(p => normalizeAttrId(p) === normalizeAttrId(selectedAttribute));
                 })
              || globalMapping;

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
            const featureHasUnmappedValues = f.values.some(v => !hasResolvedValueMapping(resolveValueMapping(effectiveMapping?.valueMappings, v)));

            if (showUnmappedOnly && !featureHasUnmappedAttribute && !featureHasUnmappedValues) {
              return null;
            }

            if (feasibilityFilter || valueStatusFilter) {
              const anyValueMatches = f.values.some(v => {
                const vm = effectiveMapping?.valueMeta?.[v];
                const feasOk = !feasibilityFilter || (vm?.feasibility || '') === feasibilityFilter;
                const statusOk = !valueStatusFilter || (vm?.valueStatus || '') === valueStatusFilter;
                return feasOk && statusOk;
              });
              if (!anyValueMatches) {
                return null;
              }
            }

            let candidateValuesForAttribute = attributeCandidateValues[selectedAttribute] || [];
            if (useNewClassTargetMapping && (stagedClassId || 'UNCLASSIFIED') !== 'UNCLASSIFIED') {
              const activeClass = classes.find(c => c.classId === (stagedClassId || 'UNCLASSIFIED'));
              const attrDef = activeClass?.attributes.find(a => normalizeAttrId(a.attributeId) === normalizeAttrId(selectedAttribute));
              if (attrDef && attrDef.allowedValues && attrDef.allowedValues.length > 0) {
                candidateValuesForAttribute = attrDef.allowedValues;
              }
            }
            // Ensure NOT REQUIRED is always available as a value option
            if (!candidateValuesForAttribute.includes('NOT REQUIRED')) {
              candidateValuesForAttribute = [...candidateValuesForAttribute, 'NOT REQUIRED'];
            }
            // Multiple tone only when global-generated with multiple candidates
            // and user hasn't confirmed via local override yet.
            const isUserConfirmed = localOverride?.mappedFrom === 'local';
            const attributeTone: Tone = selectedAttribute === 'UNMAPPED'
              ? 'unmapped'
              : selectedAttribute === 'NOT REQUIRED'
              ? 'notRequired'
              : hasMultipleOptions && !isUserConfirmed
              ? 'multiple'
              : featureHasUnmappedValues
              ? 'partial'
              : 'mapped';
            const attributePalette = toneTheme[attributeTone];
            const isExpanded = !!expandedFeatures[f.featureId];

            // Migration approval (feature level). Features whose values are all
            // NOT REQUIRED / discontinued / infeasible are auto-satisfied and
            // need no manual approval.
            const featureValuesList = f.values || [];
            const allValuesInactive = featureValuesList.length > 0 && featureValuesList.every(v => {
              const vm = effectiveMapping?.valueMeta?.[v];
              const vs = (vm?.valueStatus || '').toLowerCase();
              const feas = (vm?.feasibility || '').toLowerCase();
              return vs === 'discontinued' || vs === 'ignored' || vs === 'deprecated' || feas === 'no';
            });
            const isFeatureAutoSatisfied = attributeTone === 'notRequired' || allValuesInactive;
            const featureApprover = approvalState?.features?.[f.featureId];
            const isFeatureApproved = !!featureApprover;
            const featureApprovalTitle = isFeatureApproved && featureApprover?.approvedByUsername
              ? `Approved by ${featureApprover.approvedByUsername}${featureApprover.approvedAt ? ' · ' + new Date(featureApprover.approvedAt * 1000).toLocaleString() : ''}`
              : isFeatureAutoSatisfied
              ? 'Auto-satisfied (not required / discontinued) — counts as approved'
              : 'Approve this feature for migration';

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
                        <p className={`text-sm font-black leading-tight ${attributeTone === 'mapped' ? 'text-emerald-900' : attributeTone === 'partial' ? 'text-orange-900' : attributeTone === 'notRequired' ? 'text-amber-900' : attributeTone === 'multiple' ? 'text-violet-900' : 'text-rose-900'}`}>{f.featureId}</p>
                        <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">{f.description}</p>
                        {f.condition && (
                          <p className="text-[8px] text-indigo-500 font-bold mt-0.5" title="Condition">{f.condition}</p>
                        )}
                        {f.formula && (
                          <p className="text-[8px] text-purple-500 font-bold mt-0.5" title="Formula">{f.formula}</p>
                        )}
                        {f.formula && (
                          <p className="text-[8px] text-purple-500 font-bold mt-0.5" title="Formula">{f.formula}</p>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1 min-w-[220px]">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {isFeatureAutoSatisfied ? (
                          <span title={featureApprovalTitle} className="px-2 py-0.5 bg-slate-100 text-slate-500 text-[7px] font-black rounded-full uppercase tracking-wider inline-flex items-center gap-1">
                            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                            Auto
                          </span>
                        ) : isLockedByMe ? (
                          <button
                            type="button"
                            onClick={() => handleToggleFeatureApproval(f.featureId)}
                            title={featureApprovalTitle}
                            className={`px-2 py-0.5 text-[7px] font-black rounded-full uppercase tracking-wider inline-flex items-center gap-1 border transition-colors ${
                              isFeatureApproved
                                ? 'bg-emerald-600 border-emerald-500 text-white hover:bg-emerald-700'
                                : 'bg-white border-emerald-300 text-emerald-700 hover:bg-emerald-50'
                            }`}
                          >
                            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                            {isFeatureApproved ? 'Approved' : 'Approve'}
                          </button>
                        ) : isFeatureApproved ? (
                          <span title={featureApprovalTitle} className="px-2 py-0.5 bg-emerald-100 text-emerald-700 text-[7px] font-black rounded-full uppercase tracking-wider inline-flex items-center gap-1">
                            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                            Approved
                          </span>
                        ) : null}
                        {localOverride && localOverride.mappedFrom === 'local' && (
                          <span className="px-2 py-0.5 bg-purple-100 text-purple-700 text-[7px] font-black rounded-full uppercase tracking-wider">
                            Local
                          </span>
                        )}
                        {(globalMapping || localOverride) && (!localOverride || localOverride.mappedFrom !== 'local') && (
                          <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-[7px] font-black rounded-full uppercase tracking-wider">
                            Global
                          </span>
                        )}
                        {hasMultipleOptions && (
                          <span className="px-2 py-0.5 bg-violet-100 text-violet-700 text-[7px] font-black rounded-full uppercase tracking-wider">
                            Multiple
                          </span>
                        )}
                      </div>

                      {/* Target Attribute Selector/Display */}
                      <div className="w-full max-w-xs">
                        {isLockedByMe ? (
                          <SearchableSelect
                            tone={attributeTone}
                            value={selectedAttribute}
                            onChange={(val) => handleUpdateLinkage(f.featureId, val)}
                            featureId={f.featureId}
                            classId={stagedClassId && stagedClassId !== 'UNCLASSIFIED' ? stagedClassId : undefined}
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
                        const resolvedVal = resolveValueMapping(effectiveMapping?.valueMappings, v);
                        const isValueMapped = selectedAttribute !== 'UNMAPPED' && hasResolvedValueMapping(resolvedVal);
                        const mappedValue = isValueMapped ? resolvedVal! : '';
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

                        // Per-row metadata sourced from workspace_mappings (via grouped GlobalMapping.valueMeta)
                        const valueMeta = effectiveMapping?.valueMeta?.[v];
                        const rowCondition = (valueMeta?.condition ?? f.condition) || '';
                        const rowFeasibility = valueMeta?.feasibility || '';
                        const rowValueStatus = valueMeta?.valueStatus || '';

                        if (feasibilityFilter && rowFeasibility !== feasibilityFilter) {
                          return null;
                        }
                        if (valueStatusFilter && rowValueStatus !== valueStatusFilter) {
                          return null;
                        }

                        return (
                          <div
                            key={`${item.itemId}-${f.featureId}-row-${vidx}`}
                            className="grid grid-cols-[1fr_0.8fr_auto_1fr_0.8fr_0.7fr_auto_auto] gap-2 items-center"
                          >
                            {/* Source value */}
                            <div className="px-3 py-2 bg-slate-900 text-white rounded-lg text-[9px] font-black uppercase tracking-tight truncate max-w-full">
                              <span className="truncate">{v}</span>
                            </div>
                            {/* Source value description */}
                            <div className="px-2 py-2 bg-slate-100 text-slate-500 rounded-lg text-[8px] font-medium normal-case tracking-normal truncate min-h-[32px]" title={legacyDesc}>
                              {legacyDesc || ''}
                            </div>

                            <div className="flex items-center justify-center text-2xl font-black text-slate-300">
                              →
                            </div>

                            {/* Target value */}
                            <div>
                              {isReadOnly ? (
                                <div className={`px-3 py-2 rounded-lg text-[9px] font-black uppercase tracking-tight truncate ${valuePalette.valueReadonly}`}>
                                  {valueTone === 'notRequired' ? 'N/A' : mappedValue || '—'}
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
                                </div>
                              )}
                            </div>
                            {/* Target value description */}
                            <div className="px-2 py-2 bg-slate-50 text-slate-500 rounded-lg text-[8px] font-medium normal-case tracking-normal truncate min-h-[32px] border border-slate-100" title={targetValueDescription}>
                              {targetValueDescription || ''}
                            </div>
                            {/* Condition */}
                            <div
                              className="px-2 py-2 bg-indigo-50/60 text-indigo-600 rounded-lg text-[8px] font-bold normal-case tracking-normal truncate min-h-[32px] border border-indigo-100"
                              title={rowCondition ? `Condition: ${rowCondition}` : 'No condition'}
                            >
                              {rowCondition || <span className="text-slate-300 font-medium">—</span>}
                            </div>
                            {/* Feasibility */}
                            <div
                              className={`px-2 py-2 rounded-lg text-[8px] font-black uppercase tracking-tight text-center min-h-[32px] flex items-center justify-center border w-14 ${
                                rowFeasibility === 'Yes'
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                  : rowFeasibility === 'No'
                                    ? 'bg-rose-50 text-rose-600 border-rose-200'
                                    : 'bg-slate-50 text-slate-300 border-slate-100'
                              }`}
                              title={rowFeasibility ? `Feasibility: ${rowFeasibility}` : 'Feasibility not set'}
                            >
                              {rowFeasibility || '—'}
                            </div>
                            {/* Value status */}
                            <div
                              className={`px-2 py-2 rounded-lg text-[8px] font-black uppercase tracking-tight text-center min-h-[32px] flex items-center justify-center border w-20 ${
                                rowValueStatus
                                  ? 'bg-amber-50 text-amber-700 border-amber-200'
                                  : 'bg-slate-50 text-slate-300 border-slate-100'
                              }`}
                              title={rowValueStatus ? `Value status: ${rowValueStatus}` : 'No value status'}
                            >
                              {rowValueStatus || '—'}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          });

              const visibleCards = renderedCards.filter(Boolean);
              if (visibleCards.length === 0) return null;

              return (
                <div key={`type-group-${typeKey}`} className="mb-6">
                  <div className="flex items-center gap-2 mb-3 px-1">
                    <div className="h-px flex-1 bg-slate-200" />
                    <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest whitespace-nowrap">
                      {groupLabel}
                    </span>
                    <span className="px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 text-[8px] font-black">
                      {visibleCards.length}
                    </span>
                    <div className="h-px flex-1 bg-slate-200" />
                  </div>
                  <div className="space-y-3">
                    {visibleCards}
                  </div>
                </div>
              );
            });
          })()}

          {ignoredFeatures.length > 0 && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/50 p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[9px] font-black text-amber-700 uppercase tracking-widest">Ignore</p>
                <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[8px] font-black uppercase tracking-widest">
                  {ignoredFeatures.length} Source Attribute{ignoredFeatures.length === 1 ? '' : 's'}
                </span>
              </div>
              <p className="text-[9px] text-amber-700/80 mb-3">These attributes are grouped here because their mapping type is currently unchecked in Attribute Type Configuration.</p>
              <div className="space-y-2">
                {ignoredFeatures.map((f, idx) => {
                  const localOverride = stagedLocalMappings.find(m => (m.legacyFeatureIds || []).includes(f.featureId));
                  const globalOverride = (globalByFeatureMap[f.featureId] || [])[0] || allGlobalMappingsByFeature[f.featureId];
                  const effective = localOverride || globalOverride;
                  const target = effective?.newAttributeId || 'UNMAPPED';
                  const type = normalizeMappingType(effective?.attributeType) || 'blank';
                  return (
                    <div key={`ignore-${f.featureId}-${idx}`} className="rounded-lg border border-amber-200 bg-white px-3 py-2 flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-black text-amber-900">{f.featureId}</p>
                        <p className="text-[9px] font-bold uppercase tracking-wider text-amber-700/80">{f.description || 'No description'}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[8px] font-black uppercase tracking-widest text-amber-600">{type}</p>
                        <p className="text-[10px] font-black text-amber-900">{target}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

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
