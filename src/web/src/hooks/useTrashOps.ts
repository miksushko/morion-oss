import { useCallback } from 'react';
import { api, type Note } from '../lib/api';
import type { useConfirm } from '../components/ConfirmDialog';

type Confirm = ReturnType<typeof useConfirm>;

/**
 * Trash actions: restore one, hard-delete one, hard-delete all.
 * Optimistic local updates; rollback by refetching trash when the
 * server rejects. Restore re-pulls notes/folders/tags too because the
 * note re-materializes wherever it used to live.
 */
export function useTrashOps(args: {
  selectedTrashId: string | null;
  trashedNotes: Note[];
  setTrashedNotes: React.Dispatch<React.SetStateAction<Note[]>>;
  refreshNotes: () => Promise<void>;
  refreshFolders: () => Promise<void>;
  refreshTags: () => Promise<void>;
  refreshTrash: () => Promise<void>;
  showToast: (message: string) => void;
  confirm: Confirm;
}) {
  const {
    selectedTrashId,
    trashedNotes,
    setTrashedNotes,
    refreshNotes,
    refreshFolders,
    refreshTags,
    refreshTrash,
    showToast,
    confirm,
  } = args;

  const restoreNote = useCallback(
    async (noteId: string) => {
      setTrashedNotes((cur) => cur.filter((n) => n.id !== noteId));
      try {
        await api.restoreNote(noteId);
      } catch (err) {
        console.error(err);
        refreshTrash().catch(console.error);
        return;
      }
      refreshNotes().catch(console.error);
      refreshFolders().catch(console.error);
      refreshTags().catch(console.error);
      showToast('Note restored');
    },
    [setTrashedNotes, refreshNotes, refreshFolders, refreshTags, refreshTrash, showToast],
  );

  const restoreSelectedTrashNote = useCallback(async () => {
    if (!selectedTrashId) return;
    await restoreNote(selectedTrashId);
  }, [selectedTrashId, restoreNote]);

  const deleteForeverSelectedTrashNote = useCallback(async () => {
    if (!selectedTrashId) return;
    const note = trashedNotes.find((n) => n.id === selectedTrashId);
    if (!note) return;
    const label = note.title?.trim() || 'Untitled';
    const ok = await confirm({
      title: 'Delete forever?',
      description: `"${label}" will be permanently deleted. This cannot be undone.`,
      confirmLabel: 'Delete forever',
      destructive: true,
    });
    if (!ok) return;
    const id = selectedTrashId;
    setTrashedNotes((cur) => cur.filter((n) => n.id !== id));
    try {
      await api.purgeNote(id);
      showToast('Note permanently deleted');
    } catch (err) {
      console.error(err);
      refreshTrash().catch(console.error);
    }
  }, [confirm, selectedTrashId, trashedNotes, setTrashedNotes, refreshTrash, showToast]);

  const emptyTrash = useCallback(async () => {
    const count = trashedNotes.length;
    if (count === 0) return;
    const ok = await confirm({
      title: 'Empty trash?',
      description: `${count} ${count === 1 ? 'note' : 'notes'} will be permanently deleted. This cannot be undone.`,
      confirmLabel: 'Empty trash',
      destructive: true,
    });
    if (!ok) return;
    setTrashedNotes([]);
    try {
      await api.emptyTrash();
      showToast(count === 1 ? '1 note permanently deleted' : `${count} notes permanently deleted`);
    } catch (err) {
      console.error(err);
      refreshTrash().catch(console.error);
    }
  }, [confirm, trashedNotes.length, setTrashedNotes, refreshTrash, showToast]);

  return {
    restoreNote,
    restoreSelectedTrashNote,
    deleteForeverSelectedTrashNote,
    emptyTrash,
  };
}
