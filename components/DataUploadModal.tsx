
import React, { useRef, useState } from 'react';
import { dbService } from '../services/dbService';
import { LegacyItem, LegacyFeature, DatabaseState, User } from '../types';

// Simple CSV parser to map rows into LegacyItem[] (bom)
function splitCSVRow(line: string): string[] {
  const result: string[] = [];
  const re = /(?:"([^"]*)")|([^,]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m[1] !== undefined) result.push(m[1]);
    else if (m[2] !== undefined) result.push(m[2].trim());
  }
  return result;
}

function parseCSVToBom(text: string): LegacyItem[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const headers = splitCSVRow(lines[0]).map(h => h.toLowerCase());

  const idx = {
    itemId: headers.indexOf('itemid') >= 0 ? headers.indexOf('itemid') : headers.indexOf('item_id'),
    itemDesc: headers.indexOf('itemdescription') >= 0 ? headers.indexOf('itemdescription') : headers.indexOf('item_description'),
    itemCategory: headers.indexOf('category'),
    itemProductType: headers.indexOf('producttype') >= 0 ? headers.indexOf('producttype') : headers.indexOf('product_type'),
    featureId: headers.indexOf('featureid') >= 0 ? headers.indexOf('featureid') : headers.indexOf('feature_id'),
    featureDesc: headers.indexOf('featuredescription') >= 0 ? headers.indexOf('featuredescription') : headers.indexOf('feature_description'),
    featureUnit: headers.indexOf('unit'),
    featureValue: headers.indexOf('featurevalue') >= 0 ? headers.indexOf('featurevalue') : headers.indexOf('feature_value'),
    featureValueDesc: headers.indexOf('valuedescription') >= 0 ? headers.indexOf('valuedescription') : headers.indexOf('value_description'),
  } as Record<string, number>;

  // fallback to common names if not found
  if (idx.itemId < 0) idx.itemId = headers.indexOf('id');
  if (idx.itemDesc < 0) idx.itemDesc = headers.indexOf('description');

  const itemsMap: Record<string, { item: LegacyItem; featuresMap: Record<string, LegacyFeature> }> = {};

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVRow(lines[i]);
    const itemId = cols[idx.itemId] ?? '';
    if (!itemId) continue;
    const itemDesc = cols[idx.itemDesc] ?? '';
    const itemCategory = idx.itemCategory >= 0 ? (cols[idx.itemCategory] ?? '') : '';
    const itemProductType = idx.itemProductType >= 0 ? (cols[idx.itemProductType] ?? '') : '';
    const fId = cols[idx.featureId] ?? '';
    const fDesc = cols[idx.featureDesc] ?? '';
    const fUnit = idx.featureUnit >= 0 ? (cols[idx.featureUnit] ?? '') : '';
    const fVal = cols[idx.featureValue] ?? '';
    const fValDesc = idx.featureValueDesc >= 0 ? (cols[idx.featureValueDesc] ?? '') : '';

    if (!itemsMap[itemId]) {
      itemsMap[itemId] = { item: { itemId, description: itemDesc, category: itemCategory, productType: itemProductType, features: [] }, featuresMap: {} };
    } else {
      if (itemCategory && !itemsMap[itemId].item.category) {
        itemsMap[itemId].item.category = itemCategory;
      }
      if (itemProductType && !itemsMap[itemId].item.productType) {
        itemsMap[itemId].item.productType = itemProductType;
      }
    }

    if (fId) {
      let feat = itemsMap[itemId].featuresMap[fId];
      if (!feat) {
        feat = { featureId: fId, description: fDesc || fId, unit: fUnit || undefined, values: [], valueDescriptions: {} };
        itemsMap[itemId].featuresMap[fId] = feat;
        itemsMap[itemId].item.features.push(feat);
      } else if (fUnit && !feat.unit) {
        feat.unit = fUnit;
      }
      if (fVal && !feat.values.includes(fVal)) {
        feat.values.push(fVal);
        if (fValDesc) {
          (feat.valueDescriptions as Record<string, string>)[fVal] = fValDesc;
        }
      }
    }
  }

  return Object.values(itemsMap).map(v => v.item);
}

interface DataUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  type: 'csv' | 'datatable';
  currentUser?: User | null;
}

const DataUploadModal: React.FC<DataUploadModalProps> = ({ isOpen, onClose, title, type, currentUser }) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [parsedBom, setParsedBom] = useState<LegacyItem[] | null>(null);
  const [tableBom, setTableBom] = useState<LegacyItem[] | null>(null);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="p-6 border-b border-gray-100 flex justify-between items-center">
          <h3 className="text-lg font-bold text-gray-900">{title}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-8">
          {type === 'csv' ? (
            <div>
              <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setMessage(null);
                setProcessing(true);
                const text = await f.text();
                try {
                  const parsed = parseCSVToBom(text);
                  setParsedBom(parsed);
                  setMessage('CSV parsed — review below and Save to persist.');
                } catch (err: any) {
                  setMessage('Error processing CSV: ' + (err?.message || String(err)));
                } finally {
                  setProcessing(false);
                }
              }} />

              <div onClick={() => fileInputRef.current?.click()} className="border-2 border-dashed border-gray-200 rounded-xl p-10 flex flex-col items-center justify-center text-center hover:border-indigo-300 transition-colors cursor-pointer group">
                <div className="bg-indigo-50 p-4 rounded-full text-indigo-600 mb-4 group-hover:scale-110 transition-transform">
                  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-gray-700">Click to upload CSV</p>
                <p className="text-xs text-gray-400 mt-1">or drag and drop your file here</p>
              </div>
              {processing && <p className="mt-2 text-sm text-gray-500">Processing...</p>}
              {message && <p className="mt-2 text-sm text-gray-700">{message}</p>}
              {parsedBom && (
                <div className="mt-4 border rounded p-3 bg-gray-50">
                  <div className="flex justify-between items-center mb-2">
                    <strong>Preview ({parsedBom.length} items)</strong>
                    <div className="space-x-2">
                      <button type="button" className="px-3 py-1 text-sm bg-red-100 text-red-800 rounded" onClick={() => { setParsedBom(null); setMessage('Preview discarded'); }}>Discard</button>
                      <button type="button" className="px-3 py-1 text-sm bg-green-600 text-white rounded" onClick={async () => {
                        setProcessing(true);
                        try {
                          const { state } = await dbService.fetchAll();
                          const newState: DatabaseState = { ...state, bom: parsedBom };
                          await dbService.saveAll(newState);
                          setMessage('CSV saved to database.');
                          setParsedBom(null);
                        } catch (err: any) {
                          setMessage('Error saving: ' + (err?.message || String(err)));
                        } finally { setProcessing(false); }
                      }}>Save</button>
                    </div>
                  </div>
                  <div className="max-h-48 overflow-auto text-sm">
                    {parsedBom.slice(0,50).map(item => (
                      <div key={item.itemId} className="mb-2">
                        <div className="font-medium">{item.itemId} — {item.description}</div>
                        <div className="text-xs text-gray-600">
                          {item.features.map(f => (<span key={f.featureId} className="mr-2">{f.featureId}:[{f.values.join(',')} ]</span>))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {currentUser?.role !== 'admin' ? (
                <div className="p-4 bg-yellow-50 border rounded text-sm text-yellow-800">
                  Manual editing is restricted to administrators. Please contact an admin to modify data directly.
                </div>
              ) : (
                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <label className="block text-xs font-bold text-gray-500 uppercase">Quick Manual Editor</label>
                      <p className="text-xs text-gray-400">Add, edit or remove BOM items directly (admin only).</p>
                    </div>
                      <div className="flex gap-2">
                      <button type="button" onClick={async () => {
                        // load existing into table editor
                        setProcessing(true);
                        try {
                          const { state } = await dbService.fetchAll();
                          setTableBom(JSON.parse(JSON.stringify(state.bom || [])));
                          setMessage('Loaded current BOM for editing.');
                        } catch (err: any) {
                          setMessage('Failed to load BOM: ' + (err?.message || String(err)));
                        } finally { setProcessing(false); }
                      }} className="px-3 py-1 bg-gray-100 rounded text-sm">Load</button>
                      <button type="button" onClick={() => setTableBom(prev => prev ? [...prev, { itemId: `NEW-${Date.now()}`, description: '', features: [] }] : [{ itemId: `NEW-${Date.now()}`, description: '', features: [] }])} className="px-3 py-1 bg-green-600 text-white rounded text-sm">Add Item</button>
                    </div>
                  </div>

                  {!tableBom && (
                    <div className="p-3 bg-gray-50 border rounded text-sm text-gray-600">No table loaded. Click <strong>Load</strong> to fetch current BOM for editing or choose CSV upload.</div>
                  )}

                  {tableBom && (
                    <div className="space-y-3">
                      <div className="max-h-60 overflow-auto border rounded p-2 bg-white">
                        {tableBom.map((it, idx) => (
                          <div key={it.itemId} className="mb-2 p-2 border-b last:border-b-0">
                            <div className="flex gap-2 items-center">
                              <input value={it.itemId} onChange={(e) => {
                                const next = [...tableBom]; next[idx] = { ...next[idx], itemId: e.target.value }; setTableBom(next);
                              }} className="w-40 p-1 border rounded text-sm" />
                              <input value={it.description} onChange={(e) => {
                                const next = [...tableBom]; next[idx] = { ...next[idx], description: e.target.value }; setTableBom(next);
                              }} placeholder="Description" className="flex-1 p-1 border rounded text-sm" />
                              <button type="button" onClick={() => {
                                const next = tableBom.filter((_, i) => i !== idx); setTableBom(next);
                              }} className="px-2 py-1 text-sm bg-red-50 text-red-600 rounded">Remove</button>
                            </div>
                            <div className="mt-2">
                              <div className="text-xs text-gray-500 mb-1">Features</div>
                              <div className="space-y-1">
                                {it.features.map((f, fi) => (
                                  <div key={f.featureId || fi} className="flex gap-2 items-center">
                                    <input value={f.featureId} onChange={(e) => {
                                      const next = [...tableBom]; next[idx].features[fi] = { ...next[idx].features[fi], featureId: e.target.value }; setTableBom(next);
                                    }} className="w-28 p-1 border rounded text-sm" />
                                    <input value={f.description} onChange={(e) => {
                                      const next = [...tableBom]; next[idx].features[fi] = { ...next[idx].features[fi], description: e.target.value }; setTableBom(next);
                                    }} placeholder="Feature desc" className="flex-1 p-1 border rounded text-sm" />
                                    <input value={f.values.join(',')} onChange={(e) => {
                                      const next = [...tableBom]; next[idx].features[fi] = { ...next[idx].features[fi], values: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }; setTableBom(next);
                                    }} placeholder="val1,val2" className="w-40 p-1 border rounded text-sm" />
                                    <button type="button" onClick={() => {
                                      const next = [...tableBom]; next[idx].features = next[idx].features.filter((_, i) => i !== fi); setTableBom(next);
                                    }} className="px-2 py-1 text-sm bg-red-50 text-red-600 rounded">-</button>
                                  </div>
                                ))}
                                <button type="button" onClick={() => {
                                  const next = [...tableBom]; next[idx].features.push({ featureId: `F-${Date.now()}`, description: '', values: [] }); setTableBom(next);
                                }} className="mt-2 px-2 py-1 text-sm bg-blue-50 text-blue-600 rounded">Add Feature</button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => { setTableBom(null); setMessage('Changes discarded'); }} className="px-3 py-1 bg-gray-100 rounded">Discard</button>
                        <button type="button" onClick={async () => {
                          setProcessing(true);
                          try {
                            const { state } = await dbService.fetchAll();
                            const nextState: DatabaseState = { ...state, bom: tableBom || [] };
                            await dbService.saveAll(nextState);
                            setMessage('Manual edits saved.');
                            setTableBom(null);
                          } catch (err: any) { setMessage('Save error: ' + (err?.message || String(err))); }
                          finally { setProcessing(false); }
                        }} className="px-3 py-1 bg-green-600 text-white rounded">Save</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="p-6 bg-gray-50 flex justify-end gap-3">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
          <button type="button" onClick={() => { alert('Data source connected successfully!'); onClose(); }} className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm">
            {type === 'csv' ? 'Process File' : 'Connect Table'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DataUploadModal;
