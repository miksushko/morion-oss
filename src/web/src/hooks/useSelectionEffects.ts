import { useCallback, useEffect, useMemo } from 'react';
import type { Folder, Note } from '../lib/api';
import type { AppView, MobilePane } from '../appShellTypes';

/**
 * Behavioural half of the selection slice — runs AFTER `useNotesData`
 * so it can read `visibleNotes` / `trashedNotes` / `allNotes` /
 * `activeFolder`. State + the search-handoff ref live in
 * `useSelectionState`, called BEFORE `useNotesData`.
 *
 * Four behaviours, in the order they were inline in App.tsx:
 *
 *   1. **Live-list clamp.** Keeps `selectedId` valid as the visible
 *      list changes (folder filter, create, delete, move). Falls back
 *      to the first visible note when the current selection drops out
 *      of view. Skipped in trash view. Kanban mode is special — auto-
 *      pick is suppressed (the user opens cards explicitly).
 *   2. **Trash-list clamp.** Same idea isolated to the trash view so
 *      its selection survives a round trip to the live list.
 *   3. **`selectedNote` derived.** Reads from the right collection
 *      based on `view`.
 *   4. **Search hand-off race-guard.** When the user picks a note
 *      from CommandPalette that lives in a DIFFERENT folder, we snap
 *      `selectedFolderId`, which kicks off an async `refreshNotes`,
 *      and optimistically set `selectedId`. Between those,
 *      `allNotes` still holds the OLD folder's rows, so the live-
 *      list clamp would override the search pick. The pin ref pins
 *      "we're mid-handoff for this id; don't clamp until it arrives
 *      in visibleNotes (or we time out)". Clamp respects it; a 3s
 *      safety timeout releases the pin if the note never surfaces.
 *
 * Also handles the `morion:open-note` window event from
 * FolderSettingsDialog's "Open catalog note" button.
 */
export interface UseSelectionEffectsArgs {
  // From useSelectionState
  selectedFolderId: string | undefined;
  setSelectedFolderId: React.Dispatch<React.SetStateAction<string | undefined>>;
  selectedId: string | null;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
  selectedTrashId: string | null;
  setSelectedTrashId: React.Dispatch<React.SetStateAction<string | null>>;
  pendingSearchSelectionRef: React.MutableRefObject<string | null>;

  // From App (view + layout)
  view: AppView;
  setView: React.Dispatch<React.SetStateAction<AppView>>;
  setMobilePane: React.Dispatch<React.SetStateAction<MobilePane>>;

  // From useNotesData
  visibleNotes: Note[];
  trashedNotes: Note[];
  allNotes: Note[];
  activeFolder: Folder | undefined;
  refreshTrash: () => Promise<void>;
}

export function useSelectionEffects(args: UseSelectionEffectsArgs) {
  const {
    selectedFolderId,
    setSelectedFolderId,
    selectedId,
    setSelectedId,
    selectedTrashId,
    setSelectedTrashId,
    pendingSearchSelectionRef,
    view,
    setView,
    setMobilePane,
    visibleNotes,
    trashedNotes,
    allNotes,
    activeFolder,
    refreshTrash,
  } = args;

  // Live-list selection clamp.
  useEffect(() => {
    if (view === 'trash') return;

    // Search-palette hand-off: pinned selection survives stale clamp.
    if (pendingSearchSelectionRef.current === selectedId && selectedId !== null) {
      if (visibleNotes.find((n) => n.id === selectedId)) {
        pendingSearchSelectionRef.current = null;
        return; // arrived correctly — leave selection alone
      }
      return; // refresh still in flight
    }

    if (activeFolder?.viewMode === 'kanban') {
      // In kanban mode selectedId is empty until the user opens a card.
      // If the currently-selected note left this folder, drop it so the
      // drawer doesn't point at a ghost.
      if (
        selectedId !== null &&
        !visibleNotes.find((n) => n.id === selectedId)
      ) {
        setSelectedId(null);
      }
      return;
    }
    if (visibleNotes.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!visibleNotes.find((n) => n.id === selectedId)) {
      setSelectedId(visibleNotes[0]!.id);
    }
  }, [view, visibleNotes, selectedId, activeFolder, setSelectedId, pendingSearchSelectionRef]);

  // Trash-list selection clamp.
  useEffect(() => {
    if (view !== 'trash') return;
    if (trashedNotes.length === 0) {
      if (selectedTrashId !== null) setSelectedTrashId(null);
      return;
    }
    if (!trashedNotes.find((n) => n.id === selectedTrashId)) {
      setSelectedTrashId(trashedNotes[0]!.id);
    }
  }, [view, trashedNotes, selectedTrashId, setSelectedTrashId]);

  const selectedNote = useMemo(() => {
    if (view === 'trash') {
      return trashedNotes.find((n) => n.id === selectedTrashId) ?? null;
    }
    return allNotes.find((n) => n.id === selectedId) ?? null;
  }, [view, trashedNotes, selectedTrashId, allNotes, selectedId]);

  // Phase 6.7 — listen for `morion:open-note` events fired from
  // FolderSettingsDialog's ProjectSummaryTab "Open catalog note"
  // button. Window-event coupling avoids threading a setter through
  // 4+ components.
  useEffect(() => {
    function handler(event: Event) {
      const detail = (event as CustomEvent<{ noteId?: string }>).detail;
      if (!detail?.noteId) return;
      setView('notes');
      setSelectedId(detail.noteId);
    }
    window.addEventListener('morion:open-note', handler);
    return () => window.removeEventListener('morion:open-note', handler);
  }, [setView, setSelectedId]);

  const selectFolder = useCallback(
    (folderId: string | undefined) => {
      setSelectedFolderId(folderId);
      setView('notes');
      setMobilePane('notes');
      // Close the kanban drawer (if any) when switching folders — the
      // selected note may not exist in the target folder, and even if
      // it does the user expects a fresh context.
      setSelectedId(null);
    },
    [setSelectedFolderId, setView, setMobilePane, setSelectedId],
  );

  const selectView = useCallback(
    (next: AppView) => {
      setView(next);
      // Trash uses the same notes/editor split as the regular view, so
      // we land on the notes pane on mobile. Tags + Settings are full-
      // width and collapse the folder pane via `mobilePane === 'editor'`.
      if (next === 'notes' || next === 'trash') setMobilePane('notes');
      else setMobilePane('editor');
      if (next === 'trash') {
        // Lazy GC pass on the server kicks in here — also picks up any
        // notes deleted via MCP since the last refresh.
        refreshTrash().catch(console.error);
      }
    },
    [setView, setMobilePane, refreshTrash],
  );

  const selectFromSearch = useCallback(
    (note: Note) => {
      // Snap the folder filter to wherever the note actually lives.
      // Using the hit's folderId (instead of `allNotes.find(...)`)
      // covers the cross-folder case — `allNotes` is server-side
      // folder-filtered, so a search hit from a different folder is
      // never present and the old logic silently skipped the snap.
      const targetFolderId = note.folderId ?? undefined;
      if (selectedFolderId !== targetFolderId) {
        setSelectedFolderId(targetFolderId);
      }
      setView('notes');
      pendingSearchSelectionRef.current = note.id;
      window.setTimeout(() => {
        if (pendingSearchSelectionRef.current === note.id) {
          pendingSearchSelectionRef.current = null;
        }
      }, 3000);
      setSelectedId(note.id);
      setMobilePane('editor');
    },
    [
      selectedFolderId,
      setSelectedFolderId,
      setView,
      setSelectedId,
      setMobilePane,
      pendingSearchSelectionRef,
    ],
  );

  return { selectedNote, selectFolder, selectView, selectFromSearch };
}
