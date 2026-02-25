
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { DataCategory, GlobalMapping, NewClassification, NewAttribute, LegacyItem, LegacyFeature, User } from '../types';
import { dbService } from '../services/dbService';

interface DataInspectorProps {
  category: DataCategory;
  onClose: () => void;
  data: {
    mapping: GlobalMapping[];
    classification: NewClassification[];
    values: NewClassification[]; 
    bom: LegacyItem[];
    users: User[];
  };
  onSave: (category: DataCategory, updatedData: any) => void;
  onSwitchUser?: (user: User) => void;
  currentUser: User; // used to determine admin privileges
}

interface LegacyValueSelectorProps {
  value: string;
  options: string[];
  onChange: (next: string) => void;
  placeholder?: string;
  maxVisibleOptions?: number;
}

const LegacyValueSelector: React.FC<LegacyValueSelectorProps> = ({ value, options, onChange, placeholder = 'Filter...', maxVisibleOptions = 20 }) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const filteredOptions = useMemo(() => {
    const base = options || [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? base.filter(o => o.toLowerCase().includes(q))
      : base;
    return filtered.slice(0, maxVisibleOptions);
  }, [options, search, maxVisibleOptions]);

  const handleSelect = (opt: string) => {
    onChange(opt);
    setOpen(false);
    setSearch('');
  };

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="flex items-center gap-1">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="w-full text-[9px] font-black text-slate-900 bg-white px-1.5 py-1 rounded-md border border-slate-200 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300"
        />
        {options.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            className="shrink-0 p-1 rounded-md border border-slate-200 bg-slate-50 text-slate-400 hover:text-slate-600 hover:bg-slate-100"
            title="Choose legacy value"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        )}
      </div>
      {open && filteredOptions.length > 0 && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-md shadow-lg max-h-56 overflow-y-auto">
          <div className="p-1 border-b border-slate-100">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter values..."
              className="w-full px-2 py-1 text-[9px] rounded-md border border-slate-200 outline-none focus:border-indigo-400"
            />
          </div>
          <ul className="py-1 text-[9px]">
            {filteredOptions.map(opt => (
              <li key={opt}>
                <button
                  type="button"
                  onClick={() => handleSelect(opt)}
                  className="w-full text-left px-2 py-1 hover:bg-indigo-50 text-slate-700"
                >
                  {opt}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const DataInspector: React.FC<DataInspectorProps> = ({ category, onClose, data, onSave, onSwitchUser, currentUser }) => {
  const normalizeKey = (value?: string | null) => (value || '').trim().toLowerCase();
  const [localMapping, setLocalMapping] = useState<GlobalMapping[]>([]);
  const [localClassification, setLocalClassification] = useState<NewClassification[]>([]);
  const [localBom, setLocalBom] = useState<LegacyItem[]>([]);
  const [localUsers, setLocalUsers] = useState<User[]>([]);
  const [page, setPage] = useState(0);
  const [mappingSearch, setMappingSearch] = useState('');
  const [bomSearch, setBomSearch] = useState('');
  const [selectedBomItemId, setSelectedBomItemId] = useState<string | null>(null);
  const [legacyValueFilter, setLegacyValueFilter] = useState('');
  const [featureFilter, setFeatureFilter] = useState('');
  const [classSearch, setClassSearch] = useState('');
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [attributeSearch, setAttributeSearch] = useState('');
  const [selectedAttributeId, setSelectedAttributeId] = useState<string | null>(null);
  const [remoteAttribute, setRemoteAttribute] = useState<NewAttribute | null>(null);
  const [isAttributeLoading, setIsAttributeLoading] = useState(false);
  const [isCsvImporting, setIsCsvImporting] = useState(false);
  const [csvImportProgress, setCsvImportProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setLocalMapping(JSON.parse(JSON.stringify(data.mapping)));
    setLocalClassification(JSON.parse(JSON.stringify(data.classification)));
    setLocalBom(JSON.parse(JSON.stringify(data.bom)));
    setLocalUsers(JSON.parse(JSON.stringify(data.users || [])));
    setPage(0);
    setMappingSearch('');
    setBomSearch('');
    setSelectedBomItemId(null);
    setLegacyValueFilter('');
    setFeatureFilter('');
    setClassSearch('');
    setSelectedClassId(null);
    setAttributeSearch('');
    setSelectedAttributeId(null);
    setRemoteAttribute(null);
    setIsAttributeLoading(false);
  }, [data, category]);

  const titles = {
    mapping: 'Global Mapping Table',
    classification: 'System Classifications',
    values: 'Attribute Value Lists',
    bom: 'Master BOM Items',
    users: 'User Identity Registry'
  };

  const PAGE_SIZE_MAPPING = 100;
  const PAGE_SIZE_BOM = 40;

  const filteredClasses = useMemo(() => {
    const q = classSearch.trim().toLowerCase();
    if (!q) return localClassification;
    return localClassification.filter(cls => {
      const id = (cls.classId || '').toLowerCase();
      const name = (cls.className || '').toLowerCase();
      return id.includes(q) || name.includes(q);
    });
  }, [localClassification, classSearch]);

  const visibleClasses = useMemo(() => {
    return filteredClasses.slice(0, 5);
  }, [filteredClasses]);

  const activeClass = useMemo(() => {
    if (selectedClassId) {
      return localClassification.find(c => c.classId === selectedClassId) || null;
    }
    return filteredClasses[0] || null;
  }, [filteredClasses, localClassification, selectedClassId]);

  useEffect(() => {
    if (!selectedClassId && filteredClasses.length) {
      setSelectedClassId(filteredClasses[0].classId);
    }
  }, [filteredClasses, selectedClassId]);

  const classDropdownOptions = useMemo(() => {
    return filteredClasses.map(cls => cls.className || cls.classId).slice(0, 5);
  }, [filteredClasses]);

  const allAttributesForActiveClass = activeClass?.attributes || [];

  const uniqueAttributeCountForActiveClass = useMemo(() => {
    const ids = new Set<string>();
    allAttributesForActiveClass.forEach(attr => {
      if (attr.attributeId) {
        ids.add(attr.attributeId);
      }
    });
    return ids.size;
  }, [allAttributesForActiveClass]);

  const filteredAttributes = useMemo(() => {
    const selectedKey = normalizeKey(selectedAttributeId);
    const q = attributeSearch.trim().toLowerCase();
    let base = allAttributesForActiveClass;
    if (q) {
      base = base.filter(attr => {
        const id = normalizeKey(attr.attributeId);
        const desc = (attr.description || '').toLowerCase();
        return id.includes(q) || desc.includes(q);
      });
    }
    if (selectedKey) {
      base = base.filter(attr => normalizeKey(attr.attributeId) === selectedKey);
    }
    return base;
  }, [allAttributesForActiveClass, attributeSearch, selectedAttributeId]);

  const attributeDropdownOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: string[] = [];
    allAttributesForActiveClass.forEach(attr => {
      const id = attr.attributeId;
      if (id && !seen.has(id)) {
        seen.add(id);
        opts.push(id);
      }
    });
    return opts;
  }, [allAttributesForActiveClass]);

  const selectedAttributeForDetail = useMemo(() => {
    const selectedKey = normalizeKey(selectedAttributeId);
    if (!selectedKey) return null;
    return (
      remoteAttribute ||
      allAttributesForActiveClass.find(a => normalizeKey(a.attributeId) === selectedKey) ||
      null
    );
  }, [allAttributesForActiveClass, selectedAttributeId, remoteAttribute]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedClassId || !selectedAttributeId || category === 'mapping' || category === 'bom' || category === 'users') {
      setRemoteAttribute(null);
      setIsAttributeLoading(false);
      return;
    }

    setIsAttributeLoading(true);
    dbService
      .fetchClassificationAttribute(selectedClassId, selectedAttributeId)
      .then(attr => {
        if (!cancelled) setRemoteAttribute(attr);
      })
      .catch(() => {
        if (!cancelled) setRemoteAttribute(null);
      })
      .finally(() => {
        if (!cancelled) setIsAttributeLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [category, selectedClassId, selectedAttributeId]);

  const addAllowedValueToSelected = () => {
    if (!selectedClassId || !selectedAttributeId) return;
    const nextValue = prompt('Enter a new allowed value:');
    if (!nextValue) return;
    const trimmed = nextValue.trim();
    if (!trimmed) return;

    const classIdx = localClassification.findIndex(c => c.classId === selectedClassId);
    if (classIdx === -1) return;

    const next = [...localClassification];
    const attrs = next[classIdx].attributes.map(attr => {
      if (normalizeKey(attr.attributeId) !== normalizeKey(selectedAttributeId)) return attr;
      const existing = attr.allowedValues || [];
      if (existing.map(v => normalizeKey(v)).includes(normalizeKey(trimmed))) return attr;
      return { ...attr, allowedValues: [...existing, trimmed] };
    });
    next[classIdx] = { ...next[classIdx], attributes: attrs };
    setLocalClassification(next);

    if (remoteAttribute && normalizeKey(remoteAttribute.attributeId) === normalizeKey(selectedAttributeId)) {
      const existing = remoteAttribute.allowedValues || [];
      if (!existing.map(v => normalizeKey(v)).includes(normalizeKey(trimmed))) {
        setRemoteAttribute({
          ...remoteAttribute,
          allowedValues: [...existing, trimmed],
        });
      }
    }
  };

  const addAttributeToActiveClass = () => {
    if (!activeClass) return;

    const rawId = prompt('Enter new attribute ID:');
    if (!rawId) return;
    const trimmedId = rawId.trim();
    if (!trimmedId) return;

    const classIdx = localClassification.findIndex(c => c.classId === activeClass.classId);
    if (classIdx === -1) return;

    const existingAttrs = localClassification[classIdx].attributes || [];
    const exists = existingAttrs.some(a => normalizeKey(a.attributeId) === normalizeKey(trimmedId));
    if (exists) {
      alert('An attribute with this ID already exists in this class.');
      return;
    }

    const rawDesc = prompt('Enter attribute description (optional):') || '';

    const next = [...localClassification];
    const newAttr: NewAttribute = {
      attributeId: trimmedId,
      description: rawDesc,
      allowedValues: [],
    };

    next[classIdx] = {
      ...next[classIdx],
      attributes: [...existingAttrs, newAttr],
    };

    setLocalClassification(next);
    setSelectedAttributeId(trimmedId);
    setRemoteAttribute(null);
  };

  const removeAllowedValueFromSelected = (valueToRemove: string) => {
    if (!selectedClassId || !selectedAttributeId) return;

    const classIdx = localClassification.findIndex(c => c.classId === selectedClassId);
    if (classIdx === -1) return;

    const next = [...localClassification];
    const attrs = next[classIdx].attributes.map(attr => {
      if (normalizeKey(attr.attributeId) !== normalizeKey(selectedAttributeId)) return attr;
      const existing = attr.allowedValues || [];
      const filtered = existing.filter(v => normalizeKey(v) !== normalizeKey(valueToRemove));
      return { ...attr, allowedValues: filtered };
    });
    next[classIdx] = { ...next[classIdx], attributes: attrs };
    setLocalClassification(next);

    if (remoteAttribute && normalizeKey(remoteAttribute.attributeId) === normalizeKey(selectedAttributeId)) {
      const existing = remoteAttribute.allowedValues || [];
      const filtered = existing.filter(v => normalizeKey(v) !== normalizeKey(valueToRemove));
      setRemoteAttribute({
        ...remoteAttribute,
        allowedValues: filtered,
      });
    }
  };

  // Helper maps for quick lookup of attribute descriptions in mapping view
  const attributeDescriptions = useMemo(() => {
    const map: Record<string, string> = {};
    localClassification.forEach(cls => {
      cls.attributes.forEach(attr => {
        if (attr.attributeId && !map[attr.attributeId]) {
          map[attr.attributeId] = attr.description || attr.attributeId;
        }
      });
    });
    return map;
  }, [localClassification]);

  const filteredMapping = useMemo(() => {
    const q = mappingSearch.trim().toLowerCase();
    if (!q) return localMapping;
    return localMapping.filter(m => {
      const legacy = (m.legacyFeatureIds || []).join('|').toLowerCase();
      const target = (m.newAttributeId || '').toLowerCase();
      const desc = (attributeDescriptions[m.newAttributeId] || '').toLowerCase();
      return legacy.includes(q) || target.includes(q) || desc.includes(q);
    });
  }, [localMapping, mappingSearch, attributeDescriptions]);

  const pagedMapping = useMemo(() => {
    return filteredMapping.slice(page * PAGE_SIZE_MAPPING, (page + 1) * PAGE_SIZE_MAPPING);
  }, [filteredMapping, page]);

  const [selectedMappingIndex, setSelectedMappingIndex] = useState<number | null>(null);

  const selectedMapping = useMemo(() => {
    if (selectedMappingIndex == null) return null;
    if (selectedMappingIndex < 0 || selectedMappingIndex >= localMapping.length) return null;
    return localMapping[selectedMappingIndex];
  }, [localMapping, selectedMappingIndex]);

  const legacyValueCandidates = useMemo(() => {
    if (!selectedMapping) return [] as string[];
    const featureIds = selectedMapping.legacyFeatureIds || [];
    const valuesSet = new Set<string>();

    if (featureIds.length) {
      localBom.forEach(item => {
        item.features.forEach(feat => {
          if (featureIds.includes(feat.featureId)) {
            feat.values.forEach(v => {
              const val = v.trim();
              if (val) valuesSet.add(val);
            });
          }
        });
      });
    }

    Object.keys(selectedMapping.valueMappings || {}).forEach(k => {
      const val = k.trim();
      if (val) valuesSet.add(val);
    });

    return Array.from(valuesSet).sort((a, b) => a.localeCompare(b));
  }, [selectedMapping, localBom]);

  const filteredBom = useMemo(() => {
    const q = bomSearch.trim().toLowerCase();
    if (!q) return localBom;
    return localBom.filter(item => {
      const id = (item.itemId || '').toLowerCase();
      const desc = (item.description || '').toLowerCase();
      return id.includes(q) || desc.includes(q);
    });
  }, [localBom, bomSearch]);

  const pagedBom = useMemo(() => {
    return filteredBom.slice(page * PAGE_SIZE_BOM, (page + 1) * PAGE_SIZE_BOM);
  }, [filteredBom, page]);

  const selectedBomItem = useMemo(() => {
    if (!selectedBomItemId) return null;
    return localBom.find(item => item.itemId === selectedBomItemId) || null;
  }, [localBom, selectedBomItemId]);

  const featureCandidates = useMemo(() => {
    if (!selectedBomItem) return [] as string[];
    return selectedBomItem.features.map(f => f.featureId).filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [selectedBomItem]);

  // --- Lightweight CSV helpers (template + parsing) ---

  const buildCsv = (rows: string[][]): string => {
    return rows.map(r => r.map(cell => cell.replace(/"/g, '""')).join(',')).join('\n');
  };

  // Robust CSV line splitter that handles quoted fields with commas
  const splitCsvLine = (line: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
        // Handle escaped quote inside a quoted field
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++; // skip next quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }

    result.push(current);
    return result;
  };

  const parseCsv = (text: string): { [key: string]: string }[] => {
    const rawLines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (!rawLines.length) return [];

    const headers = splitCsvLine(rawLines[0]).map(h => h.trim());
    const rows: { [key: string]: string }[] = [];

    for (let i = 1; i < rawLines.length; i++) {
      const cols = splitCsvLine(rawLines[i]);
      if (!cols.some(c => c.trim().length > 0)) continue;

      const row: { [key: string]: string } = {};
      headers.forEach((h, idx) => {
        row[h] = (cols[idx] ?? '').trim();
      });
      rows.push(row);
    }

    return rows;
  };

  const handleDownloadTemplate = () => {
    if (category === 'users') return;
    if ((category === 'classification' || category === 'values') && currentUser.role !== 'admin') {
      alert('Only administrators may download classification templates when using a shared SQL backend.');
      return;
    }

    let rows: string[][] = [];

    if (category === 'mapping') {
      rows = [
        ['legacyFeatureIds', 'newAttributeId', 'valuePairs'],
        ['FRM_MAT|FRAME_SPEC', 'MAT_COMP', 'RED:RED_MAT|BLUE:BLUE_MAT'],
      ];
    } else if (category === 'classification' || category === 'values') {
      rows = [
        ['classId', 'className', 'attributeId', 'attributeDescription', 'allowedValues'],
        ['TABLE', 'TABLE', 'WIDTH', 'WIDTH', '1200|600'],
      ];
    } else if (category === 'bom') {
      rows = [
        ['itemId', 'description', 'featureId', 'featureDescription', 'values'],
        ['ITEM1', 'Sample Item', 'MMW', 'WIDTH', '1200|600'],
      ];
    }

    if (!rows.length) return;
    const csv = buildCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${category}-template.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleCsvUpload: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if ((category === 'classification' || category === 'values') && currentUser.role !== 'admin') {
      alert('Only administrators may import classification records via CSV when using a shared SQL backend.');
      return;
    }

    try {
      setIsCsvImporting(true);
      setCsvImportProgress(10);
      const text = await file.text();
      setCsvImportProgress(40);
      const rows = parseCsv(text);
      if (!rows.length) {
        alert('CSV file is empty or has no data rows.');
        setIsCsvImporting(false);
        return;
      }

      if (category === 'mapping') {
        const imported: GlobalMapping[] = rows.map(r => {
          const legacyFeatureIds = (r['legacyFeatureIds'] || '')
            .split('|')
            .map(s => s.trim())
            .filter(Boolean);
          const newAttributeId = r['newAttributeId'] || '';
          const valuePairs = (r['valuePairs'] || '').split('|').map(s => s.trim()).filter(Boolean);
          const valueMappings: Record<string, string> = {};
          valuePairs.forEach(p => {
            const [from, to] = p.split(':');
            if (from && to) valueMappings[from.trim()] = to.trim();
          });
          return { legacyFeatureIds, newAttributeId, valueMappings };
        });
        const existing = [...localMapping];
        const isSameMapping = (a: GlobalMapping, b: GlobalMapping) => {
          const aKey = (a.legacyFeatureIds || []).slice().sort().join('|');
          const bKey = (b.legacyFeatureIds || []).slice().sort().join('|');
          return aKey === bKey && (a.newAttributeId || '') === (b.newAttributeId || '');
        };
        imported.forEach(m => {
          if (!existing.some(em => isSameMapping(em, m))) {
            existing.push(m);
          }
        });
        setLocalMapping(existing);
      } else if (category === 'classification' || category === 'values') {
        const next = JSON.parse(JSON.stringify(localClassification)) as NewClassification[];

        rows.forEach(r => {
          const classId = r['classId'] || '';
          const className = r['className'] || classId || 'New Classification';
          if (!classId) return;
          let cls = next.find(c => c.classId === classId);
          if (!cls) {
            cls = { classId, className, attributes: [] };
            next.push(cls);
          }
          const attributeId = r['attributeId'] || '';
          if (attributeId) {
            const allowedValues = (r['allowedValues'] || '')
              .split('|')
              .map(s => s.trim())
              .filter(Boolean);
            const existingAttr = cls.attributes.find(a => a.attributeId === attributeId);
            if (!existingAttr) {
              cls.attributes.push({
                attributeId,
                description: r['attributeDescription'] || attributeId,
                allowedValues,
              });
            } else {
              const desc = existingAttr.description || r['attributeDescription'] || attributeId;
              const mergedValues = new Set<string>(existingAttr.allowedValues || []);
              allowedValues.forEach(v => mergedValues.add(v));
              existingAttr.description = desc;
              existingAttr.allowedValues = Array.from(mergedValues);
            }
          }
        });
        setLocalClassification(next);
      } else if (category === 'bom') {
        // Support both the app's BOM template and ggg.csv format:
        // - Template: itemId, description, featureId, featureDescription, values (pipe-separated)
        // - ggg.csv: itemId, itemDescription, featureId, featureDescription, featureValue (one per row)
        const byItem: Record<string, LegacyItem> = {};

        // seed map with existing BOM so imports add on top
        localBom.forEach(item => {
          byItem[item.itemId] = JSON.parse(JSON.stringify(item));
        });

        rows.forEach(r => {
          const itemId = r['itemId'] || '';
          if (!itemId) return;

          const description = r['description'] || r['itemDescription'] || '';
          if (!byItem[itemId]) {
            byItem[itemId] = { itemId, description, features: [] };
          } else if (!byItem[itemId].description && description) {
            byItem[itemId].description = description;
          }

          const featureId = r['featureId'] || '';
          if (!featureId) return;

          const featureDescription = r['featureDescription'] || featureId;
          const rawValues = (r['values'] || r['featureValue'] || '')
            .split('|')
            .map(s => s.trim())
            .filter(Boolean);

          if (!rawValues.length) {
            return;
          }

          let feature = byItem[itemId].features.find(f => f.featureId === featureId);
          if (!feature) {
            feature = { featureId, description: featureDescription, values: [] };
            byItem[itemId].features.push(feature);
          } else if (!feature.description && featureDescription) {
            feature.description = featureDescription;
          }

          rawValues.forEach(v => {
            if (!feature!.values.includes(v)) {
              feature!.values.push(v);
            }
          });
        });

        setLocalBom(Object.values(byItem));
      }
      setCsvImportProgress(100);
    } catch (err) {
      console.error('CSV import failed', err);
      alert('Failed to parse CSV file. Please verify the format matches the template.');
    } finally {
      setTimeout(() => {
        setIsCsvImporting(false);
        setCsvImportProgress(0);
      }, 300);
    }
  };

  const handleSave = () => {
    if (category === 'mapping') onSave('mapping', localMapping);
    if (category === 'classification' || category === 'values') onSave('classification', localClassification);
    if (category === 'bom') onSave('bom', localBom);
    if (category === 'users') onSave('users', localUsers);
  };

  const addRootRow = () => {
    if ((category === 'classification' || category === 'values') && currentUser.role !== 'admin') {
      alert('Only administrators may add new classification records when using a shared SQL backend.');
      return;
    }

    if (category === 'mapping') {
      const next = [...localMapping, { legacyFeatureIds: [], newAttributeId: '', valueMappings: {} }];
      setLocalMapping(next);
      setSelectedMappingIndex(next.length - 1);
    } else if (category === 'classification' || category === 'values') {
      // Generate a unique ID for new classifications to avoid database conflicts
      const uniqueId = `NEW_CLASS_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      setLocalClassification([...localClassification, { classId: uniqueId, className: 'New Classification', attributes: [] }]);
    } else if (category === 'bom') {
      const next = [...localBom, { itemId: 'NEW-ITEM', description: 'New Item Description', features: [] }];
      setLocalBom(next);
      setSelectedBomItemId('NEW-ITEM');
    } else if (category === 'users') {
      setLocalUsers([...localUsers, { userId: `USR-${Date.now()}`, userName: 'new_user', password: 'password', role: 'user' }]);
    }
  };

  const deleteRootRow = (index: number) => {
    // disallow non-admins from deleting shared classification entries
    if ((category === 'classification' || category === 'values') && currentUser.role !== 'admin') {
      alert('Only administrators may remove shared classification records.');
      return;
    }

    if (confirm("Delete this permanent record?")) {
      if (category === 'mapping') setLocalMapping(localMapping.filter((_, i) => i !== index));
      if (category === 'classification' || category === 'values') setLocalClassification(localClassification.filter((_, i) => i !== index));
      if (category === 'bom') setLocalBom(localBom.filter((_, i) => i !== index));
      if (category === 'users') setLocalUsers(localUsers.filter((_, i) => i !== index));
    }
  };

  // Mapping-specific helper functions to restore "original" functionality
  const addValueMappingPair = (rowIdx: number) => {
    const key = prompt("Enter Legacy Value name:");
    if (!key) return;
    const next = [...localMapping];
    if (next[rowIdx].valueMappings[key]) {
      alert("This value pair already exists.");
      return;
    }
    next[rowIdx].valueMappings[key] = '';
    setLocalMapping(next);
  };

  const removeValueMappingPair = (rowIdx: number, key: string) => {
    const next = [...localMapping];
    delete next[rowIdx].valueMappings[key];
    setLocalMapping(next);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden animate-in fade-in zoom-in duration-200 border border-slate-200">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-white shrink-0">
          <div className="flex items-center gap-3">
            <div className={`p-2 text-white rounded-lg shadow-sm ${category === 'users' ? 'bg-indigo-600' : 'bg-blue-600'}`}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-900 tracking-tight leading-none">{titles[category]}</h3>
              <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest mt-1">MANAGEMENT CONSOLE</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-md transition-all">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-50/20">
          <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
            <button
              type="button"
              onClick={addRootRow}
              className="px-4 py-2 bg-slate-900 text-white rounded-lg text-[10px] font-black hover:bg-black transition-all flex items-center gap-2 uppercase tracking-widest"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
              Add Record
            </button>

            {category !== 'users' && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleDownloadTemplate}
                    className="px-3 py-1.5 border border-slate-200 bg-white rounded-lg text-[9px] font-black text-slate-600 hover:bg-slate-50 transition-all uppercase tracking-widest"
                  >
                    Download CSV Template
                  </button>
                  <button
                    type="button"
                    onClick={() => !isCsvImporting && fileInputRef.current?.click()}
                    className={`px-3 py-1.5 border rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${
                      isCsvImporting
                        ? 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed'
                        : 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                    }`}
                  >
                    {isCsvImporting ? 'Importing…' : 'Upload CSV'}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={handleCsvUpload}
                  />
                </div>
                {isCsvImporting && (
                  <div className="flex items-center gap-2 text-[9px] text-slate-500">
                    <span>Processing CSV</span>
                    <div className="w-24 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-indigo-500 transition-all"
                        style={{ width: `${csvImportProgress}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {(category === 'classification' || category === 'values') && (
              <div className="flex-1 flex flex-wrap justify-end gap-3 mt-3 sm:mt-0">
                <div className="w-48">
                  <LegacyValueSelector
                    value={classSearch}
                    options={classDropdownOptions}
                    onChange={(val) => {
                      setClassSearch(val);
                      const match = localClassification.find(c => c.className === val || c.classId === val);
                      if (match) {
                        setSelectedClassId(match.classId);
                      }
                    }}
                    placeholder="Search classes..."
                    maxVisibleOptions={5}
                  />
                </div>
                <div className="w-48">
                  <LegacyValueSelector
                    value={attributeSearch}
                    options={attributeDropdownOptions}
                    onChange={(val) => {
                      setAttributeSearch(val);
                      const normalized = val.trim().toLowerCase();
                      const matched = attributeDropdownOptions.find(opt => opt.trim().toLowerCase() === normalized);
                      setSelectedAttributeId(matched || null);
                    }}
                    placeholder="Search attributes..."
                    maxVisibleOptions={attributeDropdownOptions.length || 10}
                  />
                </div>
              </div>
            )}

            {(category === 'bom' || category === 'mapping') && (
              <div className="flex-1 flex justify-end min-w-[220px] mt-3 sm:mt-0">
                <div className="relative w-full max-w-xs">
                  <svg
                    className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-300"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M11 5a6 6 0 016 6m-1.5 4.5L21 21M5 11a6 6 0 016-6 6 6 0 016 6 6 6 0 01-6 6 6 6 0 01-6-6z"
                    />
                  </svg>
                  {category === 'bom' && (
                    <input
                      type="text"
                      value={bomSearch}
                      onChange={(e) => {
                        setBomSearch(e.target.value);
                        setPage(0);
                      }}
                      placeholder="Search item or description..."
                      className="w-full pl-7 pr-2 py-1.5 text-[10px] rounded-lg border border-slate-200 bg-white text-slate-700 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-300 placeholder:text-slate-300 font-bold"
                    />
                  )}
                  {category === 'mapping' && (
                    <input
                      type="text"
                      value={mappingSearch}
                      onChange={(e) => {
                        setMappingSearch(e.target.value);
                        setPage(0);
                      }}
                      placeholder="Search legacy or target attribute..."
                      className="w-full pl-7 pr-2 py-1.5 text-[10px] rounded-lg border border-slate-200 bg-white text-slate-700 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-300 placeholder:text-slate-300 font-bold"
                    />
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
            {category === 'users' ? (
                <table className="w-full text-left">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100">
                      <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Global ID</th>
                      <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Username</th>
                      <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Security Token</th>
                      <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Authority</th>
                      <th className="px-6 py-4 text-center text-[10px] font-black text-slate-400 uppercase tracking-widest">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {localUsers.map((user, idx) => (
                      <tr key={user.userId} className="group hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-3 font-mono text-[10px] text-slate-400">{user.userId}</td>
                        <td className="px-6 py-3">
                           <input 
                             value={user.userName}
                             onChange={(e) => {
                               const next = [...localUsers];
                               next[idx].userName = e.target.value;
                               setLocalUsers(next);
                             }}
                             className="text-xs font-black text-slate-900 bg-transparent outline-none focus:text-indigo-600 w-full"
                           />
                        </td>
                        <td className="px-6 py-3">
                           <input 
                             type="text"
                             value={user.password}
                             onChange={(e) => {
                               const next = [...localUsers];
                               next[idx].password = e.target.value;
                               setLocalUsers(next);
                             }}
                             className="text-xs font-bold text-slate-500 bg-slate-50 px-2 py-1 rounded-md outline-none w-full border border-transparent focus:border-indigo-100"
                           />
                        </td>
                        <td className="px-6 py-3">
                           <select 
                             value={user.role}
                             onChange={(e) => {
                               const next = [...localUsers];
                               next[idx].role = e.target.value as 'admin' | 'user';
                               setLocalUsers(next);
                             }}
                             className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-[4px] outline-none transition-all ${user.role === 'admin' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}
                           >
                             <option value="user">USER</option>
                             <option value="admin">ADMIN</option>
                           </select>
                        </td>
                        <td className="px-6 py-3 flex items-center justify-center gap-2">
                            {onSwitchUser && (
                              <button 
                                onClick={() => onSwitchUser(user)}
                                className="p-1.5 text-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-all"
                                title="Switch Context"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                              </button>
                            )}
                            <button 
                                onClick={() => deleteRootRow(idx)}
                                className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-md transition-all"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
            ) : (
                <table className="w-full text-left">
                  {category === 'mapping' && (
                    <>
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-100">
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest w-56">Schema Link</th>
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Interface Bridge</th>
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest w-16 text-center">X</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {pagedMapping.map((m, idxOnPage) => {
                          const globalIdx = localMapping.indexOf(m);
                          const isSelected = selectedMappingIndex === globalIdx;
                          const legacyLabel = (m.legacyFeatureIds || []).join(' | ') || '—';
                          const targetLabel = m.newAttributeId || 'UNMAPPED';
                          const targetDesc = attributeDescriptions[m.newAttributeId] || '';
                          return (
                            <tr
                              key={`${targetLabel}-${globalIdx}`}
                              className={`group cursor-pointer transition-colors ${
                                isSelected ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                              }`}
                              onClick={() => {
                                if (globalIdx >= 0) setSelectedMappingIndex(globalIdx);
                              }}
                            >
                              <td className="px-6 py-3 align-top">
                                <p className="text-[11px] font-black text-slate-900 truncate" title={legacyLabel}>
                                  {legacyLabel}
                                </p>
                              </td>
                              <td className="px-6 py-3 align-top">
                                <div className="flex flex-col">
                                  <span className="text-[11px] font-black text-indigo-700 truncate" title={targetLabel}>
                                    {targetLabel}
                                  </span>
                                  {targetDesc && (
                                    <span className="text-[8px] font-bold uppercase text-slate-400 truncate" title={targetDesc}>
                                      {targetDesc}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-6 py-3 align-top text-center">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (globalIdx >= 0) deleteRootRow(globalIdx);
                                  }}
                                  className="p-1.5 text-slate-300 hover:text-red-500 rounded-md transition-all"
                                >
                                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      strokeWidth={2.5}
                                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                    />
                                  </svg>
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </>
                  )}

                  {(category === 'classification' || category === 'values') && (
                    <>
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-100">
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest w-64">Domain Registry</th>
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Summary</th>
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest w-16 text-center">X</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                            {visibleClasses.map((cls, idx) => {
                              const uniqueAttributeCount = new Set((cls.attributes || []).map(a => a.attributeId)).size;
                              return (
                                <tr
                                  key={cls.classId || idx}
                                  className={`group hover:bg-slate-50 transition-colors cursor-pointer ${
                                    activeClass && activeClass.classId === cls.classId ? 'bg-blue-50/60' : ''
                                  }`}
                                  onClick={() => setSelectedClassId(cls.classId)}
                                >
                                  <td className="px-6 py-4 align-top">
                                    <p className="text-[11px] font-black text-slate-900 truncate" title={cls.className || cls.classId}>
                                      {cls.className || cls.classId}
                                    </p>
                                    <p className="text-[8px] font-mono text-slate-400 mt-1 truncate" title={cls.classId}>
                                      {cls.classId}
                                    </p>
                                  </td>
                                  <td className="px-6 py-4 align-top">
                                    <p className="text-[10px] text-slate-600 font-medium">
                                      {uniqueAttributeCount} attribute{uniqueAttributeCount === 1 ? '' : 's'} defined
                                    </p>
                                  </td>
                                  <td className="px-6 py-4 align-top text-center">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const index = localClassification.findIndex(c => c.classId === cls.classId);
                                        if (index >= 0) deleteRootRow(index);
                                      }}
                                      className="p-1.5 text-slate-300 hover:text-red-500 rounded-md transition-all"
                                    >
                                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                    </>
                  )}

                  {category === 'bom' && (
                    <>
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-100">
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest w-48">Item Master</th>
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Description</th>
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest w-16 text-center">X</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {pagedBom.map((item, visibleIdx) => {
                          const idx = filteredBom.indexOf(item);
                          const isSelected = selectedBomItemId === item.itemId;
                          return (
                            <tr
                              key={item.itemId || idx}
                              className={`group transition-colors cursor-pointer ${
                                isSelected ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                              }`}
                              onClick={() => setSelectedBomItemId(item.itemId)}
                            >
                              <td className="px-6 py-3 align-top">
                                <div className="flex items-center gap-2">
                                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border text-[9px] font-black text-slate-400 border-slate-200 bg-slate-50">
                                    {idx + 1}
                                  </span>
                                  <div>
                                    <p className="text-[11px] font-black text-slate-900 tracking-tight">
                                      {item.itemId || '—'}
                                    </p>
                                    <p className="text-[8px] font-bold uppercase text-slate-400">
                                      {item.features.length} feature(s)
                                    </p>
                                  </div>
                                </div>
                              </td>
                              <td className="px-6 py-3 align-top">
                                <p className="text-[10px] text-slate-700 font-medium line-clamp-2">
                                  {item.description || 'No description'}
                                </p>
                              </td>
                              <td className="px-6 py-3 align-top text-center">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const globalIndex = localBom.findIndex(b => b.itemId === item.itemId);
                                    if (globalIndex >= 0) {
                                      deleteRootRow(globalIndex);
                                    }
                                  }}
                                  className="p-1.5 text-slate-300 hover:text-red-500 rounded-md transition-all"
                                >
                                  <svg
                                    className="w-5 h-5"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      strokeWidth={2.5}
                                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                    />
                                  </svg>
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </>
                  )}
                </table>
            )}
          </div>

          {/* Pagination controls for large datasets */}
          {category === 'mapping' && filteredMapping.length > PAGE_SIZE_MAPPING && (
            <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
              <span className="font-bold">
                Records {page * PAGE_SIZE_MAPPING + 1}–
                {Math.min((page + 1) * PAGE_SIZE_MAPPING, filteredMapping.length)} of {filteredMapping.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page === 0}
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  className={`px-2 py-1 rounded border text-[9px] font-black uppercase tracking-widest ${
                    page === 0
                      ? 'border-slate-100 text-slate-300 cursor-not-allowed'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  Prev
                </button>
                <button
                  type="button"
                  disabled={(page + 1) * PAGE_SIZE_MAPPING >= filteredMapping.length}
                  onClick={() => setPage(p => ((p + 1) * PAGE_SIZE_MAPPING < filteredMapping.length ? p + 1 : p))}
                  className={`px-2 py-1 rounded border text-[9px] font-black uppercase tracking-widest ${
                    (page + 1) * PAGE_SIZE_MAPPING >= filteredMapping.length
                      ? 'border-slate-100 text-slate-300 cursor-not-allowed'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {category === 'bom' && filteredBom.length > PAGE_SIZE_BOM && (
            <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
              <span className="font-bold">
                Items {page * PAGE_SIZE_BOM + 1}–
                {Math.min((page + 1) * PAGE_SIZE_BOM, filteredBom.length)} of {filteredBom.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page === 0}
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  className={`px-2 py-1 rounded border text-[9px] font-black uppercase tracking-widest ${
                    page === 0
                      ? 'border-slate-100 text-slate-300 cursor-not-allowed'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  Prev
                </button>
                <button
                  type="button"
                  disabled={(page + 1) * PAGE_SIZE_BOM >= filteredBom.length}
                  onClick={() => setPage(p => ((p + 1) * PAGE_SIZE_BOM < filteredBom.length ? p + 1 : p))}
                  className={`px-2 py-1 rounded border text-[9px] font-black uppercase tracking-widest ${
                    (page + 1) * PAGE_SIZE_BOM >= filteredBom.length
                      ? 'border-slate-100 text-slate-300 cursor-not-allowed'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {(category === 'classification' || category === 'values') && (
            <div className="mt-4 flex gap-4 min-h-[200px]">
              {/* Left: Summary & Attribute List */}
              <div className="flex-1 bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex flex-col">
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-3">Summary</p>
                {activeClass ? (
                  <>
                    <div className="mb-3">
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">
                        Attributes in Class
                      </p>
                      <p className="text-[10px] text-slate-600 font-medium">
                        {uniqueAttributeCountForActiveClass} attribute{uniqueAttributeCountForActiveClass === 1 ? '' : 's'} defined
                      </p>
                    </div>

                    <div className="flex-1 flex flex-col min-h-0">
                      <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">
                        Attribute List
                      </p>
                      {attributeDropdownOptions.length === 0 ? (
                        <p className="text-[8px] text-slate-400 italic">No attributes defined yet.</p>
                      ) : (
                        <div className="mt-1 rounded-md border border-slate-100 bg-slate-50/40 max-h-40 overflow-y-auto">
                          {attributeDropdownOptions.map(attrId => {
                            const isSelected = normalizeKey(attrId) === normalizeKey(selectedAttributeId);
                            return (
                              <button
                                key={attrId}
                                type="button"
                                onClick={() => setSelectedAttributeId(attrId)}
                                className={`w-full text-left px-2.5 py-1.5 text-[9px] font-black uppercase tracking-widest border-b last:border-b-0 ${
                                  isSelected
                                    ? 'bg-indigo-50 text-indigo-700 border-indigo-100'
                                    : 'bg-transparent text-slate-700 border-slate-100 hover:bg-slate-50'
                                }`}
                              >
                                {attrId}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={addAttributeToActiveClass}
                          className="inline-flex items-center gap-1 px-3 py-1 rounded-full border border-dashed border-slate-300 text-[8px] font-black uppercase tracking-widest text-slate-600 hover:text-indigo-600 hover:border-indigo-300"
                        >
                          <span className="text-xs leading-none">+</span>
                          <span>Add Attribute</span>
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center">
                    <p className="text-[9px] text-slate-400 italic">Select a class to view attributes</p>
                  </div>
                )}
              </div>

              {/* Right: Domain Registry & Attribute Details */}
              <div className="flex-1 bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex flex-col">
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-3">Domain Registry</p>
                <div className="text-[10px] text-slate-600 font-medium flex-1">
                  {activeClass ? (
                    <>
                      <p className="text-xs font-black text-slate-900 mb-2">{activeClass.className || activeClass.classId}</p>
                      <p className="text-[9px] text-slate-500 mb-3">{activeClass.classId}</p>

                      {selectedAttributeForDetail ? (
                        <div className="flex flex-col min-h-0">
                          <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">
                            Selected Attribute
                          </p>
                          <p
                            className="text-[10px] font-black text-slate-900 truncate"
                            title={selectedAttributeForDetail.attributeId}
                          >
                            {selectedAttributeForDetail.attributeId}
                          </p>
                          <p
                            className="text-[9px] text-slate-600 truncate"
                            title={selectedAttributeForDetail.description}
                          >
                            {selectedAttributeForDetail.description || '—'}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-1 max-h-24 overflow-y-auto">
                            <button
                              type="button"
                              onClick={addAllowedValueToSelected}
                              className="px-2 py-0.5 rounded-full border border-dashed border-slate-300 text-slate-500 text-[8px] font-black uppercase tracking-widest hover:text-indigo-600 hover:border-indigo-300"
                              title="Add allowed value"
                            >
                              +
                            </button>
                            {isAttributeLoading ? (
                              <span className="text-[8px] text-slate-400">Loading...</span>
                            ) : (selectedAttributeForDetail.allowedValues || []).length === 0 ? (
                              <span className="text-[8px] text-slate-400">No values</span>
                            ) : (
                              (selectedAttributeForDetail.allowedValues || []).map(v => (
                                <div
                                  key={v}
                                  className="relative inline-flex items-center group"
                                >
                                  <span className="px-2 py-0.5 pr-4 rounded-full bg-slate-100 text-slate-700 text-[8px] font-black uppercase tracking-widest">
                                    {v}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => removeAllowedValueFromSelected(v)}
                                    className="absolute -right-1 -top-1 w-3.5 h-3.5 rounded-full bg-red-500 text-white flex items-center justify-center text-[7px] opacity-0 group-hover:opacity-100 shadow-sm transition-opacity"
                                    title="Remove value"
                                  >
                                    ×
                                  </button>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      ) : (
                        <p className="text-[9px] text-slate-400 italic mt-1">
                          Select an attribute from the list to view details.
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="h-full flex items-center justify-center">
                      <p className="text-[9px] text-slate-400 italic">No classification selected</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {category === 'mapping' && selectedMapping && (
          <div className="px-6 pb-4 pt-1 bg-slate-50/40 border-t border-slate-100">
            <div className="max-w-5xl mx-auto bg-white rounded-xl border border-slate-200 shadow-sm p-4 mt-3">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">
                    Selected Mapping Detail
                  </p>
                  <p className="text-xs font-black text-slate-900 truncate">
                    {(selectedMapping.legacyFeatureIds || []).join(' | ') || 'New Mapping'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedMappingIndex(null)}
                  className="p-1.5 rounded-md text-slate-300 hover:text-slate-600 hover:bg-slate-50 transition-all"
                  title="Close mapping detail"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1 block">
                    Legacy Features
                  </label>
                  <input
                    value={(selectedMapping.legacyFeatureIds || []).join('|')}
                    onChange={(e) => {
                      if (selectedMappingIndex == null) return;
                      const next = [...localMapping];
                      next[selectedMappingIndex] = {
                        ...next[selectedMappingIndex],
                        legacyFeatureIds: e.target.value
                          .split('|')
                          .map(s => s.trim())
                          .filter(Boolean),
                      };
                      setLocalMapping(next);
                    }}
                    placeholder="e.g. FRM_MAT|FRAME_SPEC"
                    className="w-full p-2 text-[10px] bg-slate-50 border border-slate-200 rounded-md font-bold text-slate-900 outline-none focus:border-indigo-400"
                  />
                </div>
                <div>
                  <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1 block">
                    Target ERP Attribute
                  </label>
                  <input
                    value={selectedMapping.newAttributeId}
                    onChange={(e) => {
                      if (selectedMappingIndex == null) return;
                      const next = [...localMapping];
                      next[selectedMappingIndex] = {
                        ...next[selectedMappingIndex],
                        newAttributeId: e.target.value,
                      };
                      setLocalMapping(next);
                    }}
                    placeholder="e.g. MAT_COMP"
                    className="w-full p-2 text-[10px] bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-md font-black outline-none focus:border-indigo-400"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                    Legacy → Target Value Bridge
                  </p>
                  <div className="flex items-center gap-2">
                    <div className="w-48">
                      <LegacyValueSelector
                        value={legacyValueFilter}
                        options={legacyValueCandidates}
                        onChange={(val) => setLegacyValueFilter(val)}
                        placeholder="Filter legacy values..."
                      />
                    </div>
                    {legacyValueFilter && (
                      <button
                        type="button"
                        onClick={() => setLegacyValueFilter('')}
                        className="px-2 py-1 rounded-md text-[8px] font-black text-slate-400 hover:text-slate-600 hover:bg-slate-100 uppercase tracking-widest transition-all"
                        title="Clear filter"
                      >
                        Clear
                      </button>
                    )}
                    {selectedMappingIndex != null && (
                      <button
                        type="button"
                        onClick={() => addValueMappingPair(selectedMappingIndex)}
                        className="px-2 py-1 border border-dashed border-slate-300 rounded-md text-[8px] font-black text-slate-500 hover:text-indigo-600 hover:border-indigo-300 uppercase tracking-widest flex items-center gap-1 shrink-0"
                        title="Add custom legacy value"
                      >
                        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                        </svg>
                        Add Pair
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-64 overflow-y-auto pr-1">
                  {Object.entries(selectedMapping.valueMappings || {})
                    .filter(([k]) => {
                      if (!legacyValueFilter.trim()) return true;
                      return k.toLowerCase().includes(legacyValueFilter.toLowerCase());
                    })
                    .map(([k, v]) => (
                    <div
                      key={k}
                      className="flex items-center gap-2 p-2 bg-slate-50 rounded-lg border border-slate-200 group/pair relative"
                    >
                      <span className="text-[9px] font-black text-slate-900 w-24 truncate" title={k}>
                        {k}
                      </span>
                      <svg
                        className="w-3 h-3 text-slate-300 shrink-0"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                      </svg>
                      <input
                        value={v}
                        onChange={(e) => {
                          if (selectedMappingIndex == null) return;
                          const next = [...localMapping];
                          next[selectedMappingIndex] = {
                            ...next[selectedMappingIndex],
                            valueMappings: {
                              ...next[selectedMappingIndex].valueMappings,
                              [k]: e.target.value,
                            },
                          };
                          setLocalMapping(next);
                        }}
                        placeholder="Target Value"
                        className="flex-1 text-[9px] font-black text-indigo-600 bg-white px-1.5 py-1 rounded-md border border-indigo-100 outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                      {selectedMappingIndex != null && (
                        <button
                          type="button"
                          onClick={() => removeValueMappingPair(selectedMappingIndex, k)}
                          className="absolute -top-1.5 -right-1.5 opacity-0 group-hover/pair:opacity-100 w-4 h-4 bg-red-500 text-white rounded-full flex items-center justify-center shadow-sm transition-all hover:scale-110"
                        >
                          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {(category === 'classification' || category === 'values') && null}

        {category === 'bom' && selectedBomItem && (
          <div className="px-6 pb-6 pt-1 bg-slate-50/40 border-t border-slate-100">
            <div className="max-w-4xl mx-auto bg-white rounded-xl border border-slate-200 shadow-sm p-4 mt-3">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">
                    Selected Item Detail
                  </p>
                  <p className="text-xs font-black text-slate-900">
                    {selectedBomItem.itemId || 'New Item'}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
                <div className="md:col-span-1">
                  <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1 block">
                    Part Number
                  </label>
                  <input
                    value={selectedBomItem.itemId}
                    onChange={(e) => {
                      const idx = localBom.findIndex(i => i.itemId === selectedBomItem.itemId);
                      if (idx === -1) return;
                      const next = [...localBom];
                      next[idx] = { ...next[idx], itemId: e.target.value };
                      setLocalBom(next);
                      setSelectedBomItemId(e.target.value);
                    }}
                    className="w-full p-2 text-[10px] bg-slate-50 border border-slate-200 rounded-md font-black text-slate-900 outline-none focus:border-indigo-400"
                    placeholder="Part Number"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1 block">
                    Part Description
                  </label>
                  <textarea
                    value={selectedBomItem.description}
                    onChange={(e) => {
                      const idx = localBom.findIndex(i => i.itemId === selectedBomItem.itemId);
                      if (idx === -1) return;
                      const next = [...localBom];
                      next[idx] = { ...next[idx], description: e.target.value };
                      setLocalBom(next);
                    }}
                    className="w-full p-2 text-[10px] bg-white border border-slate-200 rounded-md font-medium text-slate-700 h-16 resize-none outline-none focus:border-indigo-400"
                    placeholder="Part Description"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Legacy Features & Values</p>
                  <div className="flex items-center gap-2">
                    <div className="w-48">
                      <LegacyValueSelector
                        value={featureFilter}
                        options={featureCandidates}
                        onChange={(val) => setFeatureFilter(val)}
                        placeholder="Filter features..."
                      />
                    </div>
                    {featureFilter && (
                      <button
                        type="button"
                        onClick={() => setFeatureFilter('')}
                        className="px-2 py-1 rounded-md text-[8px] font-black text-slate-400 hover:text-slate-600 hover:bg-slate-100 uppercase tracking-widest transition-all"
                        title="Clear filter"
                      >
                        Clear
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        const idx = localBom.findIndex(i => i.itemId === selectedBomItem.itemId);
                        if (idx === -1) return;
                        const next = [...localBom];
                        next[idx].features.push({ featureId: 'NEW_FEAT', description: 'New Feature', values: [] });
                        setLocalBom(next);
                      }}
                      className="px-2 py-1 border border-dashed border-slate-300 rounded-md text-[8px] font-black text-slate-500 hover:text-slate-700 hover:border-slate-400 uppercase tracking-widest flex items-center gap-1 shrink-0"
                    >
                      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                      </svg>
                      Add
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-64 overflow-y-auto pr-1">
                  {selectedBomItem.features.map((feat, fIdx) => {
                    const parentIdx = localBom.findIndex(i => i.itemId === selectedBomItem.itemId);
                    if (parentIdx === -1) return null;
                    
                    // Apply filter
                    if (featureFilter.trim() && !feat.featureId.toLowerCase().includes(featureFilter.toLowerCase())) {
                      return null;
                    }
                    
                    return (
                      <div
                        key={`${feat.featureId}-${fIdx}`}
                        className="p-2 bg-white rounded-lg border border-slate-200 group/feat relative"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <input
                            value={feat.featureId}
                            onChange={(e) => {
                              const next = [...localBom];
                              next[parentIdx].features[fIdx].featureId = e.target.value;
                              setLocalBom(next);
                            }}
                            className="text-[9px] font-black text-slate-900 flex-1 outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const next = [...localBom];
                              next[parentIdx].features = next[parentIdx].features.filter((_, i) => i !== fIdx);
                              setLocalBom(next);
                            }}
                            className="opacity-0 group-hover/feat:opacity-100 p-0.5 text-slate-300 hover:text-red-500 transition-all"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                        <input
                          value={feat.values.join(', ')}
                          onChange={(e) => {
                            const next = [...localBom];
                            next[parentIdx].features[fIdx].values = e.target.value
                              .split(',')
                              .map(s => s.trim())
                              .filter(Boolean);
                            setLocalBom(next);
                          }}
                          placeholder="Values (comma separated)"
                          className="w-full text-[8px] text-slate-400 font-bold uppercase truncate bg-transparent outline-none focus:text-slate-600"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-4 bg-white border-t border-slate-100 flex justify-end gap-3 shrink-0">
          <button onClick={onClose} className="px-5 py-2 text-[10px] font-black text-slate-400 hover:text-slate-600 transition-colors uppercase tracking-widest">
            Discard
          </button>
          <button 
            onClick={handleSave}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg text-[10px] font-black hover:bg-blue-700 shadow-md transition-all active:scale-95 uppercase tracking-widest"
          >
            Synchronize
          </button>
        </div>
      </div>
    </div>
  );
};

export default DataInspector;
