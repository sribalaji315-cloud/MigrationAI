
import React from 'react';
import { LegacyItem, ItemLock } from '../types';

type ItemStatus = 'mapped' | 'unmapped' | 'notRequired';

interface ItemSidebarProps {
  items: LegacyItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  locks: Record<string, ItemLock>;
  currentUserId: string;
  itemStatuses?: Record<string, ItemStatus>;
}

const statusPalette: Record<ItemStatus, { wrapper: string; badge: string; indicator: string; text: string }> = {
  mapped: {
    wrapper: 'bg-emerald-50/40 border-l-[3px] border-l-emerald-500',
    badge: 'bg-emerald-100 text-emerald-700',
    indicator: 'bg-emerald-400',
    text: 'text-emerald-800',
  },
  unmapped: {
    wrapper: 'bg-rose-50/50 border-l-[3px] border-l-rose-500',
    badge: 'bg-rose-100 text-rose-700',
    indicator: 'bg-rose-400',
    text: 'text-rose-800',
  },
  notRequired: {
    wrapper: 'bg-amber-50/50 border-l-[3px] border-l-amber-500',
    badge: 'bg-amber-100 text-amber-700',
    indicator: 'bg-amber-400',
    text: 'text-amber-800',
  },
};

const ItemSidebar: React.FC<ItemSidebarProps> = ({ items, selectedId, onSelect, locks, currentUserId, itemStatuses }) => {
  return (
    <div className="w-64 bg-white border-r border-slate-200 flex flex-col h-full shrink-0">
      <div className="p-4 border-b border-slate-100 bg-slate-50/30">
        <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-3">BOM Index ({items.length})</h2>
        <div className="relative">
          <input 
            type="text" 
            placeholder="Search records..." 
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500/30 transition-shadow"
          />
          <svg className="w-3.5 h-3.5 absolute left-2.5 top-2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto no-scrollbar">
        {items.map((item) => {
          const lock = locks[item.itemId];
          const isLockedByOthers = lock && lock.userId !== currentUserId;
          const isLockedByMe = lock && lock.userId === currentUserId;
          const status: ItemStatus | undefined = itemStatuses?.[item.itemId];
          const palette = status ? statusPalette[status] : null;
          const statusLabel = status === 'mapped' ? 'Mapped' : status === 'notRequired' ? 'Not Required' : 'Unmapped';

          return (
            <button
              key={item.itemId}
              onClick={() => onSelect(item.itemId)}
              className={`w-full text-left px-4 py-3 border-b border-slate-50 transition-all relative ${
                palette ? palette.wrapper : selectedId === item.itemId ? 'bg-blue-50/50 border-l-[3px] border-l-blue-600' : 'bg-transparent'
              } ${selectedId === item.itemId ? 'ring-1 ring-indigo-100' : ''}`}
            >
              <div className="flex items-center justify-between">
                <p className={`text-xs font-black truncate tracking-tight ${palette ? palette.text : selectedId === item.itemId ? 'text-blue-900' : 'text-slate-900'}`}>{item.itemId}</p>
                {lock && (
                  <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded-[3px] text-[7px] font-black uppercase ${isLockedByMe ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                    {isLockedByMe ? 'DRAFT' : 'BUSY'}
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between mt-0.5 gap-2">
                <p className="text-[10px] text-slate-400 line-clamp-1 font-medium flex-1">{item.description}</p>
                {palette && (
                  <span className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded-full ${palette.badge}`}>
                    {statusLabel}
                  </span>
                )}
              </div>
              
              {isLockedByOthers && (
                 <p className="text-[8px] text-amber-600 font-black mt-1.5 flex items-center gap-1 uppercase tracking-wider">
                   <span className="w-1 h-1 bg-amber-400 rounded-full animate-pulse"></span>
                   {lock.userName}
                 </p>
              )}
              {isLockedByMe && (
                 <p className="text-[8px] text-green-600 font-black mt-1.5 flex items-center gap-1 uppercase tracking-wider">
                   <span className="w-1 h-1 bg-green-400 rounded-full animate-pulse"></span>
                   Active Session
                 </p>
              )}
              {status && !isLockedByMe && (
                 <p className="text-[8px] font-black mt-1 flex items-center gap-1 uppercase tracking-wider text-slate-400">
                   <span className={`w-1 h-1 rounded-full ${palette?.indicator}`}></span>
                   {statusLabel}
                 </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ItemSidebar;
