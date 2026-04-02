import { useState, useMemo } from 'react';
import { DatabaseState, User } from '../types';

type ItemStatus = 'mapped' | 'unmapped' | 'notRequired';

const normalizeMappingType = (value?: string | null) => (value || '').trim().toLowerCase();

export function useItemStatusTracking(
  dbState: DatabaseState | null,
  currentUser: User | null,
  showUnmappedOnlyInSidebar: boolean,
) {
  const [itemStatuses, setItemStatuses] = useState<Record<string, ItemStatus>>({});

  const visibleBomItems = useMemo(() => {
    if (!dbState || !currentUser) return [] as DatabaseState['bom'];
    if (currentUser.role === 'admin') {
      return dbState.bom || [];
    }
    const lockedIds = new Set(
      Object.values(dbState.locks || {})
        .filter(lock => lock.userId === currentUser.userId)
        .map(lock => lock.itemId)
    );
    return (dbState.bom || []).filter(item => lockedIds.has(item.itemId));
  }, [dbState, currentUser]);

  const sidebarItems = useMemo(() => {
    if (!showUnmappedOnlyInSidebar) return visibleBomItems;
    return visibleBomItems.filter(item => itemStatuses[item.itemId] === 'unmapped');
  }, [visibleBomItems, showUnmappedOnlyInSidebar, itemStatuses]);

  const includedMappingTypes = useMemo(() => {
    const available = (dbState?.mappingTypeConfig?.availableTypes || []).map(normalizeMappingType).filter(Boolean);
    const included = (dbState?.mappingTypeConfig?.includedTypes || []).map(normalizeMappingType).filter(Boolean);
    if (!available.length) {
      return null;
    }
    const includeSet = new Set(included.length ? included : available);
    return includeSet;
  }, [dbState]);

  return {
    itemStatuses,
    setItemStatuses,
    visibleBomItems,
    sidebarItems,
    includedMappingTypes,
  };
}
