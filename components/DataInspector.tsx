
import React, { useState, useEffect, useRef } from 'react';
import { DataCategory, GlobalMapping, NewClassification, NewAttribute, LegacyItem, LegacyFeature, User } from '../types';

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

const DataInspector: React.FC<DataInspectorProps> = ({ category, onClose, data, onSave, onSwitchUser, currentUser }) => {
  const [localMapping, setLocalMapping] = useState<GlobalMapping[]>([]);
  const [localClassification, setLocalClassification] = useState<NewClassification[]>([]);
  const [localBom, setLocalBom] = useState<LegacyItem[]>([]);
  const [localUsers, setLocalUsers] = useState<User[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setLocalMapping(JSON.parse(JSON.stringify(data.mapping)));
    setLocalClassification(JSON.parse(JSON.stringify(data.classification)));
    setLocalBom(JSON.parse(JSON.stringify(data.bom)));
    setLocalUsers(JSON.parse(JSON.stringify(data.users || [])));
  }, [data, category]);

  const titles = {
    mapping: 'Global Mapping Table',
    classification: 'System Classifications',
    values: 'Attribute Value Lists',
    bom: 'Master BOM Items',
    users: 'User Identity Registry'
  };

  // --- Lightweight CSV helpers (template + parsing) ---

  const buildCsv = (rows: string[][]): string => {
    return rows.map(r => r.map(cell => cell.replace(/"/g, '""')).join(',')).join('\n');
  };

  const parseCsv = (text: string): { [key: string]: string }[] => {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const headers = lines[0].split(',').map(h => h.trim());
    const rows: { [key: string]: string }[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (!cols.some(c => c.trim())) continue;
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
      const text = await file.text();
      const rows = parseCsv(text);
      if (!rows.length) {
        alert('CSV file is empty or has no data rows.');
        return;
      }

      if (category === 'mapping') {
        const next: GlobalMapping[] = rows.map(r => {
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
        setLocalMapping(next);
      } else if (category === 'classification' || category === 'values') {
        const byClass: Record<string, NewClassification> = {};
        rows.forEach(r => {
          const classId = r['classId'] || '';
          const className = r['className'] || classId || 'New Classification';
          if (!classId) return;
          if (!byClass[classId]) {
            byClass[classId] = { classId, className, attributes: [] };
          }
          const attributeId = r['attributeId'] || '';
          if (attributeId) {
            const allowedValues = (r['allowedValues'] || '')
              .split('|')
              .map(s => s.trim())
              .filter(Boolean);
            byClass[classId].attributes.push({
              attributeId,
              description: r['attributeDescription'] || attributeId,
              allowedValues,
            });
          }
        });
        setLocalClassification(Object.values(byClass));
      } else if (category === 'bom') {
        const byItem: Record<string, LegacyItem> = {};
        rows.forEach(r => {
          const itemId = r['itemId'] || '';
          if (!itemId) return;
          const description = r['description'] || '';
          if (!byItem[itemId]) {
            byItem[itemId] = { itemId, description, features: [] };
          }
          const featureId = r['featureId'] || '';
          if (featureId) {
            const values = (r['values'] || '')
              .split('|')
              .map(s => s.trim())
              .filter(Boolean);
            byItem[itemId].features.push({
              featureId,
              description: r['featureDescription'] || featureId,
              values,
            });
          }
        });
        setLocalBom(Object.values(byItem));
      }
    } catch (err) {
      console.error('CSV import failed', err);
      alert('Failed to parse CSV file. Please verify the format matches the template.');
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
      setLocalMapping([...localMapping, { legacyFeatureIds: [], newAttributeId: '', valueMappings: {} }]);
    } else if (category === 'classification' || category === 'values') {
      // Generate a unique ID for new classifications to avoid database conflicts
      const uniqueId = `NEW_CLASS_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      setLocalClassification([...localClassification, { classId: uniqueId, className: 'New Classification', attributes: [] }]);
    } else if (category === 'bom') {
      setLocalBom([...localBom, { itemId: 'NEW-ITEM', description: 'New Item Description', features: [] }]);
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
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-1.5 border border-indigo-200 bg-indigo-50 rounded-lg text-[9px] font-black text-indigo-700 hover:bg-indigo-100 transition-all uppercase tracking-widest"
                >
                  Upload CSV
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={handleCsvUpload}
                />
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
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest w-48">Schema Link</th>
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Interface Bridge</th>
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest w-16 text-center">X</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {localMapping.map((m, idx) => (
                          <tr key={idx} className="group hover:bg-slate-50 transition-colors">
                            <td className="px-6 py-4 align-top">
                               <div className="space-y-3">
                                  <div>
                                     <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-0.5 block">Legacy Features</label>
                                     <input 
                                       value={m.legacyFeatureIds.join("|")}
                                       placeholder="e.g. FRM_MAT|FRAME_SPEC"
                                       onChange={(e) => {
                                         const next = [...localMapping];
                                         next[idx].legacyFeatureIds = e.target.value.split("|").map(s => s.trim()).filter(Boolean);
                                         setLocalMapping(next);
                                       }}
                                       className="w-full p-2 text-[10px] bg-slate-50 border border-slate-200 rounded-md font-bold outline-none focus:border-indigo-400"
                                     />
                                  </div>
                                  <div>
                                     <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-0.5 block">Target ERP Attribute</label>
                                     <input 
                                       value={m.newAttributeId}
                                       placeholder="e.g. MAT_COMP"
                                       onChange={(e) => {
                                         const next = [...localMapping];
                                         next[idx].newAttributeId = e.target.value;
                                         setLocalMapping(next);
                                       }}
                                       className="w-full p-2 text-[10px] bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-md font-black outline-none focus:border-indigo-400"
                                     />
                                  </div>
                               </div>
                            </td>
                            <td className="px-6 py-4 align-top">
                               <div className="flex flex-col gap-2">
                                  <div className="grid grid-cols-2 gap-2">
                                    {Object.entries(m.valueMappings).map(([k, v]) => (
                                      <div key={k} className="flex items-center gap-2 p-2 bg-slate-50 rounded-lg border border-slate-200 group/pair relative">
                                         <span className="text-[9px] font-black text-slate-900 w-24 truncate" title={k}>{k}</span>
                                         <svg className="w-3 h-3 text-slate-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
                                         <input 
                                           value={v}
                                           placeholder="Target Value"
                                           onChange={(e) => {
                                              const next = [...localMapping];
                                              next[idx].valueMappings[k] = e.target.value;
                                              setLocalMapping(next);
                                           }}
                                           className="flex-1 text-[9px] font-black text-indigo-600 bg-white px-1.5 py-1 rounded-md border border-indigo-100 outline-none focus:ring-1 focus:ring-indigo-400"
                                         />
                                         <button 
                                           onClick={() => removeValueMappingPair(idx, k)}
                                           className="absolute -top-1.5 -right-1.5 opacity-0 group-hover/pair:opacity-100 w-4 h-4 bg-red-500 text-white rounded-full flex items-center justify-center shadow-sm transition-all hover:scale-110"
                                         >
                                            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                                         </button>
                                      </div>
                                    ))}
                                  </div>
                                  <button 
                                    onClick={() => addValueMappingPair(idx)}
                                    className="w-full mt-1 p-2 border border-dashed border-slate-200 rounded-lg text-[8px] font-black text-slate-400 hover:text-indigo-600 hover:border-indigo-300 transition-all uppercase flex items-center justify-center gap-1.5"
                                  >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                                    Define Value Bridge
                                  </button>
                               </div>
                            </td>
                            <td className="px-6 py-4 align-top text-center">
                               <button onClick={() => deleteRootRow(idx)} className="p-1.5 text-slate-300 hover:text-red-500 rounded-md transition-all">
                                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                               </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}

                  {(category === 'classification' || category === 'values') && (
                    <>
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-100">
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest w-48">Domain Registry</th>
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Attributes & Logic Constraints</th>
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest w-16 text-center">X</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {localClassification.map((cls, idx) => (
                          <tr key={idx} className="group hover:bg-slate-50 transition-colors">
                            <td className="px-6 py-4 align-top">
                               <input 
                                 value={cls.classId}
                                 onChange={(e) => {
                                   const next = [...localClassification];
                                   next[idx].classId = e.target.value;
                                   setLocalClassification(next);
                                 }}
                                 placeholder="Class ID"
                                 className="w-full p-2 text-[10px] bg-slate-50 border border-slate-200 rounded-md font-black text-slate-900 mb-2 outline-none focus:border-indigo-400"
                               />
                               <input 
                                 value={cls.className}
                                 onChange={(e) => {
                                   const next = [...localClassification];
                                   next[idx].className = e.target.value;
                                   setLocalClassification(next);
                                 }}
                                 placeholder="Display Name"
                                 className="w-full p-2 text-[10px] bg-white border border-slate-100 rounded-md font-bold text-slate-400 outline-none focus:border-indigo-400"
                               />
                            </td>
                            <td className="px-6 py-4 align-top">
                               <div className="grid grid-cols-2 gap-2">
                                  {cls.attributes.map((attr, aIdx) => (
                                    <div key={aIdx} className="p-2 bg-white rounded-lg border border-slate-200 group/attr relative">
                                       <div className="flex items-center gap-2 mb-1">
                                          <input 
                                            value={attr.attributeId}
                                            onChange={(e) => {
                                              const next = [...localClassification];
                                              next[idx].attributes[aIdx].attributeId = e.target.value;
                                              setLocalClassification(next);
                                            }}
                                            className="text-[9px] font-black text-blue-600 flex-1 outline-none"
                                          />
                                          <button 
                                            onClick={() => {
                                              const next = [...localClassification];
                                              next[idx].attributes = next[idx].attributes.filter((_, i) => i !== aIdx);
                                              setLocalClassification(next);
                                            }}
                                            className="opacity-0 group-hover/attr:opacity-100 p-0.5 text-slate-300 hover:text-red-500 transition-all"
                                          >
                                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                                          </button>
                                       </div>
                                       <input 
                                         value={attr.description}
                                         onChange={(e) => {
                                           const next = [...localClassification];
                                           next[idx].attributes[aIdx].description = e.target.value;
                                           setLocalClassification(next);
                                         }}
                                         placeholder="Attribute Description"
                                         className="w-full text-[8px] text-slate-400 font-bold uppercase truncate bg-transparent outline-none focus:text-slate-600 mb-1"
                                       />
                                       <input 
                                         value={(attr.allowedValues || []).join("|")}
                                         onChange={(e) => {
                                           const next = [...localClassification];
                                           next[idx].attributes[aIdx].allowedValues = e.target.value.split("|").map(s => s.trim()).filter(Boolean);
                                           setLocalClassification(next);
                                         }}
                                         placeholder="Allowed values (pipe-separated)"
                                         className="w-full text-[8px] text-slate-300 font-bold bg-transparent outline-none focus:text-slate-500"
                                       />
                                    </div>
                                  ))}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const next = [...localClassification];
                                      next[idx].attributes.push({ attributeId: 'NEW_ATTR', description: 'New Attribute', allowedValues: [] });
                                      setLocalClassification(next);
                                    }}
                                    className="p-2 border border-dashed border-slate-200 rounded-lg text-[8px] font-black text-slate-300 hover:text-blue-500 hover:border-blue-200 transition-all uppercase flex items-center justify-center gap-1"
                                  >
                                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                                    Add Property
                                  </button>
                               </div>
                            </td>
                            <td className="px-6 py-4 align-top text-center">
                               <button onClick={() => deleteRootRow(idx)} className="p-1.5 text-slate-300 hover:text-red-500 rounded-md transition-all">
                                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                               </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}

                  {category === 'bom' && (
                    <>
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-100">
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest w-48">Item Master</th>
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Legacy Schema Definitions</th>
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest w-16 text-center">X</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {localBom.map((item, idx) => (
                          <tr key={idx} className="group hover:bg-slate-50 transition-colors">
                            <td className="px-6 py-4 align-top">
                               <input 
                                 value={item.itemId}
                                 onChange={(e) => {
                                   const next = [...localBom];
                                   next[idx].itemId = e.target.value;
                                   setLocalBom(next);
                                 }}
                                 placeholder="Part Number"
                                 className="w-full p-2 text-[10px] bg-slate-50 border border-slate-200 rounded-md font-black text-slate-900 mb-2 outline-none focus:border-indigo-400"
                               />
                               <textarea 
                                 value={item.description}
                                 onChange={(e) => {
                                   const next = [...localBom];
                                   next[idx].description = e.target.value;
                                   setLocalBom(next);
                                 }}
                                 placeholder="Part Description"
                                 className="w-full p-2 text-[10px] bg-white border border-slate-100 rounded-md font-bold text-slate-400 h-16 resize-none outline-none focus:border-indigo-400"
                               />
                            </td>
                            <td className="px-6 py-4 align-top">
                               <div className="grid grid-cols-2 gap-2">
                                  {item.features.map((feat, fIdx) => (
                                    <div key={fIdx} className="p-2 bg-white rounded-lg border border-slate-200 group/feat relative">
                                       <div className="flex items-center gap-2 mb-1">
                                          <input 
                                            value={feat.featureId}
                                            onChange={(e) => {
                                              const next = [...localBom];
                                              next[idx].features[fIdx].featureId = e.target.value;
                                              setLocalBom(next);
                                            }}
                                            className="text-[9px] font-black text-slate-900 flex-1 outline-none"
                                          />
                                          <button 
                                            onClick={() => {
                                              const next = [...localBom];
                                              next[idx].features = next[idx].features.filter((_, i) => i !== fIdx);
                                              setLocalBom(next);
                                            }}
                                            className="opacity-0 group-hover/feat:opacity-100 p-0.5 text-slate-300 hover:text-red-500 transition-all"
                                          >
                                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                                          </button>
                                       </div>
                                       <input 
                                         value={feat.values.join(", ")}
                                         onChange={(e) => {
                                           const next = [...localBom];
                                           next[idx].features[fIdx].values = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
                                           setLocalBom(next);
                                         }}
                                         placeholder="Values (comma separated)"
                                         className="w-full text-[8px] text-slate-400 font-bold uppercase truncate bg-transparent outline-none focus:text-slate-600"
                                       />
                                    </div>
                                  ))}
                                  <button 
                                    onClick={() => {
                                      const next = [...localBom];
                                      next[idx].features.push({ featureId: 'NEW_FEAT', description: 'New Feature', values: [] });
                                      setLocalBom(next);
                                    }}
                                    className="p-2 border border-dashed border-slate-200 rounded-lg text-[8px] font-black text-slate-300 hover:text-slate-500 hover:border-slate-300 transition-all uppercase flex items-center justify-center gap-1"
                                  >
                                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                                    Add Specification
                                  </button>
                               </div>
                            </td>
                            <td className="px-6 py-4 align-top text-center">
                               <button onClick={() => deleteRootRow(idx)} className="p-1.5 text-slate-300 hover:text-red-500 rounded-md transition-all">
                                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                               </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                </table>
            )}
          </div>
        </div>

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
