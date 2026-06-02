import { useCallback } from 'react';
import { api, type Folder, type Note } from '../lib/api';
import { copyToClipboard, formatNoteShare } from '../lib/shareWithLLM';
import type { AppView, MobilePane } from '../appShellTypes';

/**
 * Note-level CRUD + bulk + selected-note convenience wrappers.
 *
 * Splits into four groups:
 *   - Lifecycle: newNote, deleteNote, deleteSelected, updateNoteTags,
 *     archiveNote, unarchiveNote, duplicateNote, moveNote.
 *   - Bulk: bulkDeleteNotes, bulkArchiveNotes, bulkUnarchiveNotes,
 *     bulkMoveNotes — fan out N server calls, one optimistic update +
 *     one refresh. Skips the auto-folder-switch + auto-select-note
 *     side effects single moves fire (those are right when dragging
 *     one card; wrong when clearing a pile of selected cards).
 *   - Share/copy: shareNoteWithLLM (paste-into-LLM payload), copyNoteBody.
 *   - Selected-note wrappers: share/copy/duplicate/move that read
 *     `selectedNote` and forward to the by-id variants.
 *
 * `selectNote` is also here for parity — the routing branches between
 * `selectedId` (live notes) and `selectedTrashId` (trash view).
 */
export function useNoteOps(args: {
  allNotes: Note[];
  setAllNotes: React.Dispatch<React.SetStateAction<Note[]>>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  setSelectedTrashId: (id: string | null) => void;
  selectedNote: Note | null;
  selectedFolderId: string | undefined;
  setSelectedFolderId: (id: string | undefined) => void;
  view: AppView;
  setView: (view: AppView) => void;
  setMobilePane: (pane: MobilePane) => void;
  folders: Folder[];
  showArchived: boolean;
  refreshNotes: () => Promise<void>;
  refreshFolders: () => Promise<void>;
  refreshTags: () => Promise<void>;
  refreshTrash: () => Promise<void>;
  showToast: (message: string) => void;
  markFresh: (id: string) => void;
  forgetNote: (id: string) => void;
}) {
  const {
    allNotes,
    setAllNotes,
    selectedId,
    setSelectedId,
    setSelectedTrashId,
    selectedNote,
    selectedFolderId,
    setSelectedFolderId,
    view,
    setView,
    setMobilePane,
    folders,
    showArchived,
    refreshNotes,
    refreshFolders,
    refreshTags,
    refreshTrash,
    showToast,
    markFresh,
    forgetNote,
  } = args;

  const newNote = useCallback(async () => {
    // Empty body — the server derives the title from the body. Storing ''
    // keeps the empty-draft check honest: a never-touched note has truly
    // empty fields, so the discard sweep can recognise it.
    const created = await api.createNote({
      body: '',
      folderId: selectedFolderId ?? null,
    });
    markFresh(created.id);
    setAllNotes((cur) => [created, ...cur]);
    setSelectedId(created.id);
    // ⌘N from inside Tags / Settings / Trash should pop us back to the
    // live notes view so the freshly created note is actually visible.
    setView('notes');
    setMobilePane('editor');
    refreshFolders().catch(console.error);
    refreshTags().catch(console.error);
  }, [
    selectedFolderId,
    setAllNotes,
    setSelectedId,
    setView,
    setMobilePane,
    refreshFolders,
    refreshTags,
    markFresh,
  ]);

  const selectNote = useCallback(
    (id: string) => {
      if (view === 'trash') {
        setSelectedTrashId(id);
      } else {
        setSelectedId(id);
      }
      setMobilePane('editor');
    },
    [view, setSelectedId, setSelectedTrashId, setMobilePane],
  );

  const deleteNote = useCallback(
    async (noteId: string) => {
      // If the user explicitly deletes a fresh draft, take it out of the
      // session set so the discard sweep doesn't double-fire on the same id.
      forgetNote(noteId);
      await api.deleteNote(noteId);
      setAllNotes((cur) => cur.filter((n) => n.id !== noteId));
      refreshFolders().catch(console.error);
      refreshTags().catch(console.error);
      // Pull the trash so the sidebar count + (if open) the trash list both
      // pick up the freshly soft-deleted note immediately.
      refreshTrash().catch(console.error);
    },
    [setAllNotes, refreshFolders, refreshTags, refreshTrash, forgetNote],
  );

  const deleteSelected = useCallback(async () => {
    if (!selectedId) return;
    await deleteNote(selectedId);
  }, [selectedId, deleteNote]);

  const updateNoteTags = useCallback(
    async (noteId: string, nextTags: string[]) => {
      // Tags don't count as content for the empty-note check.
      // Optimistic — chips update immediately.
      setAllNotes((cur) => cur.map((n) => (n.id === noteId ? { ...n, tags: nextTags } : n)));
      try {
        const updated = await api.updateNote(noteId, { tags: nextTags });
        setAllNotes((cur) => cur.map((n) => (n.id === noteId ? updated : n)));
        refreshTags().catch(console.error);
      } catch (err) {
        console.error(err);
        refreshNotes().catch(console.error);
      }
    },
    [setAllNotes, refreshNotes, refreshTags],
  );

  /**
   * Move a note into a folder via drag-and-drop. `targetFolderId === null`
   * = drop on "All notes" (unfile). After the move we auto-select the
   * destination view + the moved note so the user can see where it landed
   * (Apple Notes parity).
   */
  const moveNote = useCallback(
    async (noteId: string, targetFolderId: string | null) => {
      const current = allNotes.find((n) => n.id === noteId);
      if (!current || current.folderId === targetFolderId) return;

      // Optimistic local move.
      setAllNotes((cur) =>
        cur.map((n) => (n.id === noteId ? { ...n, folderId: targetFolderId } : n)),
      );
      setSelectedFolderId(targetFolderId === null ? undefined : targetFolderId);
      setSelectedId(noteId);
      setView('notes');

      try {
        const updated = await api.updateNote(noteId, { folderId: targetFolderId });
        setAllNotes((cur) => cur.map((n) => (n.id === noteId ? updated : n)));
        refreshFolders().catch(console.error);
      } catch (err) {
        console.error(err);
        refreshNotes().catch(console.error);
      }
    },
    [
      allNotes,
      setAllNotes,
      setSelectedFolderId,
      setSelectedId,
      setView,
      refreshFolders,
      refreshNotes,
    ],
  );

  const archiveNote = useCallback(
    async (noteId: string) => {
      try {
        const updated = await api.archiveNote(noteId);
        if (!showArchived) {
          setAllNotes((cur) => cur.filter((n) => n.id !== noteId));
          if (selectedId === noteId) setSelectedId(null);
        } else {
          setAllNotes((cur) => cur.map((n) => (n.id === noteId ? updated : n)));
        }
        showToast('Note archived');
      } catch (err) {
        console.error(err);
        showToast('Archive failed');
      }
    },
    [showArchived, selectedId, setAllNotes, setSelectedId, showToast],
  );

  const unarchiveNote = useCallback(
    async (noteId: string) => {
      try {
        const updated = await api.unarchiveNote(noteId);
        setAllNotes((cur) => cur.map((n) => (n.id === noteId ? updated : n)));
        showToast('Note restored');
      } catch (err) {
        console.error(err);
        showToast('Unarchive failed');
      }
    },
    [setAllNotes, showToast],
  );

  /**
   * Bulk variants: ticket 01KPFPP356054AWVKCNAZSGYYR — Kanban Select-mode
   * toolbar fires these. N server calls fan out in parallel; one
   * optimistic UI update + one refresh pass afterwards. Skips the
   * auto-folder-switch + auto-select-note side effects single moves do.
   */
  const bulkDeleteNotes = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      ids.forEach((id) => forgetNote(id));
      setAllNotes((cur) => cur.filter((n) => !idSet.has(n.id)));
      await Promise.allSettled(ids.map((id) => api.deleteNote(id)));
      refreshFolders().catch(console.error);
      refreshTags().catch(console.error);
      refreshTrash().catch(console.error);
      showToast(`${ids.length} ${ids.length === 1 ? 'note' : 'notes'} moved to Trash`);
    },
    [setAllNotes, refreshFolders, refreshTags, refreshTrash, showToast, forgetNote],
  );

  const bulkArchiveNotes = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      if (!showArchived) {
        setAllNotes((cur) => cur.filter((n) => !idSet.has(n.id)));
        if (selectedId && idSet.has(selectedId)) setSelectedId(null);
      }
      const results = await Promise.allSettled(
        ids.map((id) => api.archiveNote(id)),
      );
      if (showArchived) {
        const updated = new Map<string, Note>();
        results.forEach((r) => {
          if (r.status === 'fulfilled') updated.set(r.value.id, r.value);
        });
        if (updated.size > 0) {
          setAllNotes((cur) => cur.map((n) => updated.get(n.id) ?? n));
        }
      }
      refreshFolders().catch(console.error);
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      showToast(`${ok} ${ok === 1 ? 'note' : 'notes'} archived`);
    },
    [showArchived, selectedId, setAllNotes, setSelectedId, refreshFolders, showToast],
  );

  const bulkUnarchiveNotes = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      const results = await Promise.allSettled(
        ids.map((id) => api.unarchiveNote(id)),
      );
      const updated = new Map<string, Note>();
      results.forEach((r) => {
        if (r.status === 'fulfilled') updated.set(r.value.id, r.value);
      });
      if (updated.size > 0) {
        setAllNotes((cur) => cur.map((n) => updated.get(n.id) ?? n));
      }
      refreshFolders().catch(console.error);
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      showToast(`${ok} ${ok === 1 ? 'note' : 'notes'} restored`);
    },
    [setAllNotes, refreshFolders, showToast],
  );

  const bulkMoveNotes = useCallback(
    async (ids: string[], targetFolderId: string | null) => {
      if (ids.length === 0) return;
      const dest = targetFolderId
        ? folders.find((f) => f.id === targetFolderId)
        : null;
      const idSet = new Set(ids);
      setAllNotes((cur) =>
        cur.map((n) =>
          idSet.has(n.id) ? { ...n, folderId: targetFolderId } : n,
        ),
      );
      try {
        const results = await Promise.all(
          ids.map((id) => api.updateNote(id, { folderId: targetFolderId })),
        );
        const updated = new Map(results.map((r) => [r.id, r] as const));
        setAllNotes((cur) => cur.map((n) => updated.get(n.id) ?? n));
        refreshFolders().catch(console.error);
      } catch (err) {
        console.error(err);
        refreshNotes().catch(console.error);
      }
      const destName = dest ? dest.name : 'All notes';
      showToast(`${ids.length} ${ids.length === 1 ? 'note' : 'notes'} moved to ${destName}`);
    },
    [folders, setAllNotes, refreshFolders, refreshNotes, showToast],
  );

  /**
   * Copy a structured paste-into-LLM payload (note body + morion tool
   * hints) for any note by id.
   */
  const shareNoteWithLLM = useCallback(
    async (noteId: string) => {
      const note = allNotes.find((n) => n.id === noteId);
      if (!note) return;
      await copyToClipboard(formatNoteShare(note));
      showToast('Copied');
    },
    [allNotes, showToast],
  );

  const copyNoteBody = useCallback(
    async (noteId: string) => {
      const note = allNotes.find((n) => n.id === noteId);
      if (!note) return;
      await copyToClipboard(note.body);
      showToast('Copied note body to clipboard');
    },
    [allNotes, showToast],
  );

  /**
   * Client-side note duplicate by id. No server `notes_duplicate` tool
   * yet (Direction B), so we create a new note with the same body /
   * folder / tags. Tags carry over via the existing create endpoint.
   */
  const duplicateNote = useCallback(
    async (noteId: string) => {
      const note = allNotes.find((n) => n.id === noteId);
      if (!note) return;
      const created = await api.createNote({
        body: note.body,
        folderId: note.folderId,
        tags: note.tags,
      });
      setAllNotes((cur) => [created, ...cur]);
      setSelectedId(created.id);
      refreshFolders().catch(console.error);
      refreshTags().catch(console.error);
    },
    [allNotes, setAllNotes, setSelectedId, refreshFolders, refreshTags],
  );

  const shareSelectedWithLLM = useCallback(async () => {
    if (!selectedNote) return;
    await shareNoteWithLLM(selectedNote.id);
  }, [selectedNote, shareNoteWithLLM]);

  const copySelectedBody = useCallback(async () => {
    if (!selectedNote) return;
    await copyNoteBody(selectedNote.id);
  }, [selectedNote, copyNoteBody]);

  const duplicateSelectedNote = useCallback(async () => {
    if (!selectedNote) return;
    await duplicateNote(selectedNote.id);
  }, [selectedNote, duplicateNote]);

  const moveSelectedNoteToFolder = useCallback(
    async (targetFolderId: string | null) => {
      if (!selectedNote) return;
      await moveNote(selectedNote.id, targetFolderId);
    },
    [selectedNote, moveNote],
  );

  return {
    newNote,
    selectNote,
    deleteNote,
    deleteSelected,
    updateNoteTags,
    moveNote,
    archiveNote,
    unarchiveNote,
    duplicateNote,
    bulkDeleteNotes,
    bulkArchiveNotes,
    bulkUnarchiveNotes,
    bulkMoveNotes,
    shareNoteWithLLM,
    copyNoteBody,
    shareSelectedWithLLM,
    copySelectedBody,
    duplicateSelectedNote,
    moveSelectedNoteToFolder,
  };
}
