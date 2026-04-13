import { dbService } from '../services/dbService';
import { DatabaseState, User } from '../types';

export function useLocking(
  dbState: DatabaseState | null,
  currentUser: User | null,
  setIsRefreshing: (v: boolean) => void,
  handleFetchFromDB: () => Promise<void>,
  updateLocksAndStatuses?: (itemId: string) => Promise<void>,
) {
  const handleSignOn = async (itemId: string) => {
    if (!currentUser) return;
    const existingLocks = Object.values(dbState?.locks || {}).filter(lock => lock.userId === currentUser.userId);
    if (existingLocks.length >= 20 && !existingLocks.some(lock => lock.itemId === itemId)) {
      alert('You have reached the maximum of 20 active sign-ons. Please sign off from at least one item before signing on to another.');
      return;
    }
    setIsRefreshing(true);
    const result = await dbService.acquireLock(itemId, currentUser.userId, currentUser.userName);
    if (!result.acquired) {
      if (result.reason === 'limit') {
        alert('You have reached the maximum of 20 active sign-ons. Please sign off from at least one item before signing on to another.');
      } else if (result.reason === 'locked') {
        alert('This item is currently locked by another session.');
      } else {
        alert('Failed to sign on. Please try again.');
      }
      setIsRefreshing(false);
      return;
    }
    // Lightweight refresh: only update locks + status for this item
    if (updateLocksAndStatuses) {
      await updateLocksAndStatuses(itemId);
    } else {
      await handleFetchFromDB();
    }
    setIsRefreshing(false);
  };

  const handleSignOff = async (itemId: string) => {
    if (!currentUser) return;
    setIsRefreshing(true);

    if (currentUser.role === 'admin') {
      await dbService.forceReleaseLock(itemId);
    } else {
      await dbService.releaseLock(itemId, currentUser.userId);
    }

    // Lightweight refresh: only update locks + status for this item
    if (updateLocksAndStatuses) {
      await updateLocksAndStatuses(itemId);
    } else {
      await handleFetchFromDB();
    }
    setIsRefreshing(false);
  };

  return { handleSignOn, handleSignOff };
}
