import { useCallback, useEffect, useState } from 'react';
import { api, type Folder, type FolderViewMode, type Note, type NoteStatus } from '../lib/api';
import type { useConfirm } from '../components/ConfirmDialog';
import type { MobilePane } from '../appShellTypes';

type Confirm = ReturnType<typeof useConfirm>;

/**
 * Kanban-folder lifecycle + per-folder Mo/auto-code-enabled tracking +
 * board interactions:
 *
 *   - `conciergeFolderEnabled` / `autoCodeFolderEnabled`: folderId →
 *     bool maps populated lazily on every kanban-folder selection.
 *     Drives the header status dot + Auto-code pill.
 *   - `changeFolderViewMode`: list ⇄ kanban flip with the
 *     "convert to list" confirm.
 *   - `moveTaskInKanban` / `addCard` / `openCard` / `closeDrawer`:
 *     board-level card actions with optimistic local updates.
 *
 * Status changes deliberately do NOT bump updated_at (lesson rule);
 * the optimistic patch mirrors that.
 */
export function useKanbanOps(args: {
  activeFolder: Folder | undefined;
  folders: Folder[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selectedFolderId: string | undefined;
  setAllNotes: React.Dispatch<React.SetStateAction<Note[]>>;
  setMobilePane: (pane: MobilePane) => void;
  refreshNotes: () => Promise<void>;
  refreshFolders: () => Promise<void>;
  showToast: (message: string) => void;
  markFresh: (id: string) => void;
  flushAndSnapshotForRevision: (id: string) => Promise<void>;
  confirm: Confirm;
}) {
  const {
    activeFolder,
    folders,
    selectedId,
    setSelectedId,
    selectedFolderId,
    setAllNotes,
    setMobilePane,
    refreshNotes,
    refreshFolders,
    showToast,
    markFresh,
    flushAndSnapshotForRevision,
    confirm,
  } = args;

  const [conciergeFolderEnabled, setConciergeFolderEnabled] = useState<
    Record<string, boolean>
  >({});
  const [autoCodeFolderEnabled, setAutoCodeFolderEnabled] = useState<
    Record<string, boolean>
  >({});

  // Refresh the Mo + auto-code enabled flags for the active kanban
  // folder whenever the selection changes. Keeps the header status
  // dot in sync without forcing the dialog to mount first.
  useEffect(() => {
    if (!activeFolder || activeFolder.viewMode !== 'kanban') return;
    let alive = true;
    api
      .getConciergeFolderSettings(activeFolder.id)
      .then((s) => {
        if (alive) {
          setConciergeFolderEnabled((prev) => ({ ...prev, [activeFolder.id]: s.enabled }));
          setAutoCodeFolderEnabled((prev) => ({
            ...prev,
            [activeFolder.id]: s.autoCodeEnabled,
          }));
        }
      })
      .catch(() => {
        /* Any error stays silent — the header just won't show a dot. */
      });
    return () => {
      alive = false;
    };
  }, [activeFolder]);

  const changeFolderViewMode = useCallback(
    async (folder: Folder, next: FolderViewMode) => {
      if (folder.viewMode === next) return;
      if (next === 'list') {
        const ok = await confirm({
          title: `Convert "${folder.name}" back to a list?`,
          description:
            "Your agents won't be able to work with statuses in this folder anymore. Status data is kept in the database, so converting back to kanban will restore it.",
          confirmLabel: 'Convert to list',
          cancelLabel: 'Keep kanban',
          destructive: false,
        });
        if (!ok) return;
      }
      try {
        await api.setFolderViewMode(folder.id, next);
        await refreshFolders();
        if (selectedFolderId === folder.id) {
          setSelectedId(null);
        }
      } catch (err) {
        console.error('setFolderViewMode failed', err);
        showToast('Could not change view mode');
      }
    },
    [confirm, refreshFolders, selectedFolderId, setSelectedId, showToast],
  );

  const moveTaskInKanban = useCallback(
    async (noteId: string, status: NoteStatus, afterNoteId: string | null) => {
      // Optimistic update — approximate the new position so the card
      // snaps into place before the server returns the authoritative
      // value. Mid-point between afterNoteId and the card below it;
      // null afterNoteId → top-of-column → take (minPos - 1).
      setAllNotes((cur) => {
        const existing = cur.find((n) => n.id === noteId);
        if (!existing) return cur;
        const sameFolder = cur.filter(
          (n) => n.folderId === existing.folderId && n.id !== noteId && n.status === status,
        );
        sameFolder.sort(
          (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity),
        );
        let newPos: number | null = null;
        if (status === 'note') {
          newPos = null;
        } else if (afterNoteId === null) {
          const first = sameFolder[0];
          newPos = first?.position != null ? first.position - 1 : 1;
        } else {
          const idx = sameFolder.findIndex((n) => n.id === afterNoteId);
          if (idx === -1) {
            const last = sameFolder[sameFolder.length - 1];
            newPos = last?.position != null ? last.position + 1 : 1;
          } else {
            const after = sameFolder[idx]!;
            const nextNote = sameFolder[idx + 1];
            const afterPos = after.position ?? idx;
            newPos = nextNote?.position != null ? (afterPos + nextNote.position) / 2 : afterPos + 1;
          }
        }
        return cur.map((n) =>
          n.id === noteId ? { ...n, status, position: newPos } : n,
        );
      });

      try {
        await api.moveTaskInKanban(noteId, { status, afterNoteId });
      } catch (err) {
        console.error('kanban move failed', err);
        showToast('Could not move card');
        refreshNotes().catch(console.error);
      }
    },
    [setAllNotes, refreshNotes, showToast],
  );

  const openCard = useCallback(
    (noteId: string) => {
      setSelectedId(noteId);
      setMobilePane('editor');
    },
    [setSelectedId, setMobilePane],
  );

  const addCard = useCallback(
    async (status: NoteStatus) => {
      if (selectedFolderId === undefined) return;
      try {
        const created = await api.createNote({
          body: '',
          folderId: selectedFolderId,
          status,
        });
        markFresh(created.id);
        setAllNotes((cur) => [created, ...cur]);
        setSelectedId(created.id);
        setMobilePane('editor');
        refreshFolders().catch(console.error);
      } catch (err) {
        console.error('add kanban card failed', err);
        showToast('Could not add card');
      }
    },
    [
      selectedFolderId,
      setAllNotes,
      setSelectedId,
      setMobilePane,
      refreshFolders,
      showToast,
      markFresh,
    ],
  );

  /** Close the kanban drawer. Runs the same navigate-away housekeeping
   * as switching to a different note (empty-note discard, pending patch
   * flush, idle revision snapshot) so autosave semantics stay consistent
   * between list and kanban views. */
  const closeDrawer = useCallback(() => {
    if (selectedId) {
      flushAndSnapshotForRevision(selectedId);
    }
    setSelectedId(null);
  }, [selectedId, setSelectedId, flushAndSnapshotForRevision]);

  return {
    conciergeFolderEnabled,
    setConciergeFolderEnabled,
    autoCodeFolderEnabled,
    setAutoCodeFolderEnabled,
    changeFolderViewMode,
    moveTaskInKanban,
    openCard,
    addCard,
    closeDrawer,
  };
}
