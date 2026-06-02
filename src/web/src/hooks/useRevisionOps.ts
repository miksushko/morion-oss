import { useCallback, useState } from 'react';
import { api, type Note, type NoteRevision } from '../lib/api';
import { copyToClipboard } from '../lib/shareWithLLM';

/**
 * Roll a note back to a historical revision + copy revision body.
 *
 * Before restoring we drop any pending debounced patch for this note
 * (otherwise the next debounce tick would clobber the restored content
 * with whatever the user was about to save). After the server returns
 * we bump `editorSyncToken` so EditorPane resyncs its local state from
 * the new note. Tags + folders are refreshed because the historical
 * state can reference tags/folders that aren't currently linked.
 */
export function useRevisionOps(args: {
  selectedId: string | null;
  setAllNotes: React.Dispatch<React.SetStateAction<Note[]>>;
  cancelPendingSave: (id: string) => void;
  refreshTags: () => Promise<void>;
  refreshFolders: () => Promise<void>;
  showToast: (message: string) => void;
}) {
  const { selectedId, setAllNotes, cancelPendingSave, refreshTags, refreshFolders, showToast } = args;

  const [editorSyncToken, setEditorSyncToken] = useState(0);

  const restoreRevision = useCallback(
    async (revision: NoteRevision) => {
      if (!selectedId) return;
      cancelPendingSave(selectedId);
      try {
        const restored = await api.restoreRevision(selectedId, revision.id);
        setAllNotes((cur) => cur.map((n) => (n.id === restored.id ? restored : n)));
        setEditorSyncToken((n) => n + 1);
        refreshTags().catch(console.error);
        refreshFolders().catch(console.error);
        showToast('Note restored to earlier version');
      } catch (err) {
        console.error('restoreRevision failed', err);
        showToast('Failed to restore revision');
      }
    },
    [selectedId, setAllNotes, cancelPendingSave, refreshTags, refreshFolders, showToast],
  );

  const copyRevisionBody = useCallback(
    async (revision: NoteRevision) => {
      await copyToClipboard(revision.body);
      showToast('Copied revision body to clipboard');
    },
    [showToast],
  );

  return { editorSyncToken, restoreRevision, copyRevisionBody };
}
