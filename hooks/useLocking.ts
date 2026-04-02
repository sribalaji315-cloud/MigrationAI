import { dbService } from '../services/dbService';
import { DatabaseState, User } from '../types';

export function useLocking(
  dbState: DatabaseState | null,
  currentUser: User | null,
  setIsRefreshing: (v: boolean) => void,
  handleFetchFromDB: () => Promise<void>,
) {
  const handleSignOn = async (itemId: string) => {
    if (!currentUser) return;
    const existingLocks = Object.values(dbState?.locks || {}).filter(lock => lock.userId === currentUser.userId);
    if (existingLocks.length >= 2 && !existingLocks.some(lock => lock.itemId === itemId)) {
      alert('You can only sign on to two items at a time. Please sign off another item first.');
      return;
    }
    setIsRefreshing(true);
    const result = await dbService.acquireLock(itemId, currentUser.userId, currentUser.userName);
    if (!result.acquired) {
      if (result.reason === 'limit') {
        alert('You can only sign on to two items at a time. Please sign off another item first.');
      } else if (result.reason === 'locked') {
        alert('This item is currently locked by another session.');
      } else {
        alert('Failed to sign on. Please try again.');
      }
    }
    await handleFetchFromDB();
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

    await handleFetchFromDB();
    setIsRefreshing(false);
  };

  return { handleSignOn, handleSignOff };
}
