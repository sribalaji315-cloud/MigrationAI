import { useState, useMemo } from 'react';
import { dbService } from '../services/dbService';
import { DatabaseState, User } from '../types';

type ItemStatus = 'mapped' | 'unmapped' | 'notRequired';

const BOM_PAGE_SIZE = 20;

export function useBomPagination(
  dbState: DatabaseState | null,
  currentUser: User | null,
  setDbState: React.Dispatch<React.SetStateAction<DatabaseState | null>>,
  setIsRefreshing: (v: boolean) => void,
) {
  const [bomPage, setBomPage] = useState(0);
  const [bomTotalCount, setBomTotalCount] = useState(0);
  const [bomFilters, setBomFilters] = useState<{ categories: string[]; productTypes: string[] }>({ categories: [], productTypes: [] });

  const handleFetchBomItems = async (category?: string, productType?: string) => {
    if (!dbState) return [];
    setIsRefreshing(true);
    try {
      const pageSize = 500;
      let offset = 0;
      let items: DatabaseState['bom'] = [];

      while (true) {
        const batch = await dbService.fetchBomItems(category, productType, { limit: pageSize, offset });
        items = items.concat(batch);
        if (batch.length < pageSize) break;
        offset += pageSize;
      }

      setDbState(prev => {
        if (!prev) return prev;
        const lockedIds = new Set(
          Object.values(prev.locks || {})
            .filter(lock => !currentUser || currentUser.role === 'admin' || lock.userId === currentUser.userId)
            .map(lock => lock.itemId)
        );

        const lockedItems = prev.bom.filter(item => lockedIds.has(item.itemId));
        const nextById: Record<string, DatabaseState['bom'][number]> = {};
        lockedItems.forEach(item => { nextById[item.itemId] = item; });
        items.forEach(item => { nextById[item.itemId] = item; });

        return { ...prev, bom: Object.values(nextById) };
      });
      return items;
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleBomPageChange = async (page: number) => {
    if (!dbState || !currentUser) return;
    setIsRefreshing(true);
    setBomPage(page);
    try {
      const items = await dbService.fetchBomItems(undefined, undefined, { limit: BOM_PAGE_SIZE, offset: page * BOM_PAGE_SIZE });
      setDbState(prev => {
        if (!prev) return prev;
        const lockedIds = new Set(
          Object.values(prev.locks || {})
            .filter(lock => currentUser.role === 'admin' || lock.userId === currentUser.userId)
            .map(lock => lock.itemId)
        );
        const lockedItems = prev.bom.filter(item => lockedIds.has(item.itemId));
        const nextById: Record<string, DatabaseState['bom'][number]> = {};
        lockedItems.forEach(item => { nextById[item.itemId] = item; });
        items.forEach(item => { nextById[item.itemId] = item; });
        return { ...prev, bom: Object.values(nextById) };
      });
    } catch (err) {
      console.warn('Failed to fetch BOM page', err);
    } finally {
      setIsRefreshing(false);
    }
  };

  return {
    bomPage,
    setBomPage,
    bomTotalCount,
    setBomTotalCount,
    bomFilters,
    setBomFilters,
    handleFetchBomItems,
    handleBomPageChange,
    BOM_PAGE_SIZE,
  };
}
