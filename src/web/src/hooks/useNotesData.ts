import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Folder, type Note, type Tag } from '../lib/api';
import type { AppView } from '../appShellTypes';

/**
 * First-page cap for the initial notes load. A thousand notes
 * comfortably covers the Apple Notes-style "open app, see everything"
 * UX for every real notebook measured; beyond that, `loadMoreNotes`
 * paginates via NotesList's infinite scroll. The server caps at 5000
 * per request regardless of what we ask for.
 */
const NOTES_PAGE_SIZE = 1000;

export interface UseNotesDataArgs {
  envReady: boolean;
  view: AppView;
  selectedFolderId: string | undefined;
  showArchived: boolean;
}

/**
 * Owns the four collection-state slots (notes / folders / tags /
 * trashed notes) + total counts, the page-1 fetch, infinite-scroll
 * pagination, the folder-filter ref, derived `visibleNotes` /
 * `activeFolder`, and the initial-boot fetch chain.
 *
 * R7 (2026-04-17): server-side folder filter + infinite scroll.
 * Before, `refreshNotes` always pulled up to 1000 notes regardless of
 * the open folder, and `visibleNotes` filtered client-side. That's O(n)
 * on the total, not on what the user can see. After R7, the current
 * folder filter is tracked in a ref so `refreshNotes` and
 * `loadMoreNotes` pass `?folderId=` to the server; `visibleNotes`
 * becomes `allNotes` directly (no client filter). Switching folders
 * triggers a new page-one fetch; live-sync / drag-to-folder re-fetch
 * with the current filter.
 *
 * The hook deliberately does NOT own license fetching — App handles
 * that alongside the initial load. The "all notes" global count is
 * a second round-trip on folder-filtered loads (the server's total
 * for a filtered query is just the folder's count, not the global).
 */
export function useNotesData(args: UseNotesDataArgs) {
  const { envReady, view, selectedFolderId, showArchived } = args;

  const [allNotes, setAllNotes] = useState<Note[]>([]);
  const [totalNotes, setTotalNotes] = useState<number>(0);
  // Unfiltered global total for the Sidebar "All notes" counter. After
  // R7 `allNotes.length` is folder-scoped, so it can't double as the
  // global count.
  const [globalNoteCount, setGlobalNoteCount] = useState<number>(0);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  // Soft-deleted notes inside the 7-day retention window. Loaded lazily
  // on first trash navigation and refreshed whenever we mutate the
  // trash (delete → push, restore → pull, server-side GC purge → drop).
  const [trashedNotes, setTrashedNotes] = useState<Note[]>([]);

  const notesFilterRef = useRef<{ folderId: string | null | undefined }>({
    folderId: undefined,
  });

  const refreshNotes = useCallback(async () => {
    const { folderId } = notesFilterRef.current;
    const { notes, total } = await api.listNotes({
      folderId: folderId === null || folderId === undefined ? undefined : folderId,
      limit: NOTES_PAGE_SIZE,
      offset: 0,
      includeArchived: showArchived,
    });
    setAllNotes(notes);
    setTotalNotes(total);
    // Unfiltered list ⇒ server total equals the global count; skip the
    // second round-trip. Folder-filtered ⇒ ask for X-Total-Count without
    // any filter so Sidebar "All notes" shows the true global.
    if (folderId === null || folderId === undefined) {
      setGlobalNoteCount(total);
    } else {
      api.getAllNotesCount().then(setGlobalNoteCount).catch(console.error);
    }
  }, [showArchived]);

  const loadingMoreRef = useRef(false);
  const loadMoreNotes = useCallback(async () => {
    if (loadingMoreRef.current) return;
    if (allNotes.length >= totalNotes) return;
    loadingMoreRef.current = true;
    try {
      const { folderId } = notesFilterRef.current;
      const { notes, total } = await api.listNotes({
        folderId: folderId === null || folderId === undefined ? undefined : folderId,
        limit: NOTES_PAGE_SIZE,
        offset: allNotes.length,
        includeArchived: showArchived,
      });
      setAllNotes((cur) => {
        const seen = new Set(cur.map((n) => n.id));
        const merged = [...cur];
        for (const n of notes) if (!seen.has(n.id)) merged.push(n);
        return merged;
      });
      setTotalNotes(total);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [allNotes.length, totalNotes, showArchived]);

  const refreshFolders = useCallback(async () => {
    const fetched = await api.listFolders({ includeArchived: showArchived });
    setFolders(fetched);
  }, [showArchived]);

  const refreshTags = useCallback(async () => {
    const fetched = await api.listTags();
    setTags(fetched);
  }, []);

  /**
   * Pull the current trash window from the server. The server runs a
   * lazy GC pass on each call, so this keeps the local list aligned
   * with the 7-day retention purge without a background scheduler.
   */
  const refreshTrash = useCallback(async () => {
    const fetched = await api.listTrash();
    setTrashedNotes(fetched);
  }, []);

  // Initial boot: pull every collection in parallel. License fetch
  // stays in App (it's outside the data domain).
  useEffect(() => {
    if (!envReady) return;
    refreshNotes().catch(console.error);
    refreshFolders().catch(console.error);
    refreshTags().catch(console.error);
    refreshTrash().catch(console.error);
  }, [envReady, refreshNotes, refreshFolders, refreshTags, refreshTrash]);

  // R7: push selectedFolderId into the filter ref + re-fetch from page
  // 1 whenever the open folder changes. The ref is the source of truth
  // for `refreshNotes` and `loadMoreNotes` (both close over it), so
  // live-sync / drag-move refreshes use the current filter
  // automatically without needing a useCallback dep on this state.
  useEffect(() => {
    // Skip until the env-init + first refreshNotes has run — that fetch
    // already uses the initial `undefined` (= All notes) value.
    if (!envReady) return;
    notesFilterRef.current = { folderId: selectedFolderId ?? undefined };
    refreshNotes().catch(console.error);
  }, [envReady, selectedFolderId, refreshNotes]);

  const visibleNotes = useMemo(() => {
    if (view === 'trash') return trashedNotes;
    return allNotes;
  }, [view, trashedNotes, allNotes]);

  /** Direction N — currently-open folder, or undefined for All notes. */
  const activeFolder = useMemo(
    () => folders.find((f) => f.id === selectedFolderId),
    [folders, selectedFolderId],
  );

  return {
    allNotes,
    setAllNotes,
    totalNotes,
    globalNoteCount,
    folders,
    setFolders,
    tags,
    setTags,
    trashedNotes,
    setTrashedNotes,
    visibleNotes,
    activeFolder,
    refreshNotes,
    loadMoreNotes,
    refreshFolders,
    refreshTags,
    refreshTrash,
  };
}
