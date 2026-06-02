import { useRef, useState } from 'react';

/**
 * Pure state slot for the selection slice. Split out from
 * `useSelectionEffects` so this hook can run BEFORE `useNotesData`
 * (which needs `selectedFolderId`) while the clamp-effects + derived
 * state run AFTER (they need `visibleNotes` / `activeFolder` /
 * `allNotes` from the data layer).
 *
 *   - `selectedFolderId` — currently-open folder filter (undefined =
 *     All notes view).
 *   - `selectedId` — currently-open note in the live notes/kanban
 *     view.
 *   - `selectedTrashId` — currently-open note in the trash view.
 *     Kept separate so bouncing between Trash and the live list
 *     preserves both selections.
 *   - `pendingSearchSelectionRef` — race-guard pin for the search
 *     palette hand-off (see `useSelectionEffects` for the rationale).
 */
export function useSelectionState() {
  const [selectedFolderId, setSelectedFolderId] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTrashId, setSelectedTrashId] = useState<string | null>(null);
  const pendingSearchSelectionRef = useRef<string | null>(null);

  return {
    selectedFolderId,
    setSelectedFolderId,
    selectedId,
    setSelectedId,
    selectedTrashId,
    setSelectedTrashId,
    pendingSearchSelectionRef,
  };
}
