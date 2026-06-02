import { useCallback, useState } from 'react';

const STORAGE_KEY = 'morion:showArchived';

/**
 * "Show Archived" toggle persisted in localStorage so the user's
 * preference survives across reloads. Archived folders + notes are
 * hidden from default lists; flipping this surfaces them with a muted
 * "Archived" badge. Ticket 01KPGNY92RPYA4AEPC32C9HH0P.
 */
export function useShowArchived(): [boolean, (next: boolean) => void] {
  const [showArchived, setShowArchivedState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const setShowArchived = useCallback((next: boolean) => {
    setShowArchivedState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* storage unavailable — session-only preference is fine */
    }
  }, []);

  return [showArchived, setShowArchived];
}
