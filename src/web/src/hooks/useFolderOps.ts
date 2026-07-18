import { useCallback } from 'react';
import { api, type Folder } from '../lib/api';
import { copyToClipboard, formatFolderShare } from '../lib/shareWithLLM';
import type { FolderSettingsTab } from '../components/FolderSettingsDialog';
import type { AppView } from '../appShellTypes';

/**
 * Folder catalogue + per-folder admin: create / rename / archive /
 * delete / duplicate / move / reorder / share / open settings, plus
 * the two "create as kanban" convenience handlers.
 */
export function useFolderOps(args: {
  folders: Folder[];
  setFolders: React.Dispatch<React.SetStateAction<Folder[]>>;
  selectedFolderId: string | undefined;
  setSelectedFolderId: (id: string | undefined) => void;
  setView: (view: AppView) => void;
  refreshNotes: () => Promise<void>;
  refreshTags: () => Promise<void>;
  showToast: (message: string) => void;
  setFolderSettingsDialog: (next: { folder: Folder; tab: FolderSettingsTab } | null) => void;
}) {
  const {
    folders,
    setFolders,
    selectedFolderId,
    setSelectedFolderId,
    setView,
    refreshNotes,
    refreshTags,
    showToast,
    setFolderSettingsDialog,
  } = args;

  const createFolder = useCallback(
    async (name: string) => {
      const created = await api.createFolder(name);
      setFolders((cur) => [...cur, created]);
      setSelectedFolderId(created.id);
      setView('notes');
    },
    [setFolders, setSelectedFolderId, setView],
  );

  const createKanbanFolder = useCallback(
    async (name: string) => {
      const created = await api.createFolder(name);
      try {
        const kanban = await api.setFolderViewMode(created.id, 'kanban');
        setFolders((cur) => [...cur, kanban]);
        setSelectedFolderId(kanban.id);
        setView('notes');
      } catch {
        // Roll back the orphan list folder so the sidebar doesn't grow
        // an empty "kanban-name but list-mode" entry.
        await api.deleteFolder(created.id).catch(() => {});
        showToast('Could not create kanban board');
      }
    },
    [setFolders, setSelectedFolderId, setView, showToast],
  );

  const renameFolder = useCallback(
    async (id: string, name: string) => {
      const updated = await api.renameFolder(id, name);
      setFolders((cur) => cur.map((f) => (f.id === id ? updated : f)));
    },
    [setFolders],
  );

  const deleteFolder = useCallback(
    async (id: string, opts: { keepNotes?: boolean } = {}) => {
      await api.deleteFolder(id, opts);
      setFolders((cur) => cur.filter((f) => f.id !== id));
      // Default: notes are soft-deleted (deleted_at set) with the folder —
      // restorable from Trash. With keepNotes: notes are unfiled
      // (folderId = null) and survive in the workspace.
      if (selectedFolderId === id) setSelectedFolderId(undefined);
      refreshNotes().catch(console.error);
    },
    [setFolders, selectedFolderId, setSelectedFolderId, refreshNotes],
  );

  const archiveFolder = useCallback(
    async (id: string) => {
      try {
        const updated = await api.archiveFolder(id);
        setFolders((cur) => cur.map((f) => (f.id === id ? updated : f)));
        // If the archived folder was selected, snap back to All notes —
        // the archived board is now hidden behind the toggle.
        if (selectedFolderId === id) setSelectedFolderId(undefined);
        refreshNotes().catch(console.error);
        showToast('Folder archived');
      } catch (err) {
        console.error(err);
        showToast('Archive failed');
      }
    },
    [setFolders, selectedFolderId, setSelectedFolderId, refreshNotes, showToast],
  );

  const unarchiveFolder = useCallback(
    async (id: string) => {
      try {
        const updated = await api.unarchiveFolder(id);
        setFolders((cur) => cur.map((f) => (f.id === id ? updated : f)));
        refreshNotes().catch(console.error);
        showToast('Folder restored');
      } catch (err) {
        console.error(err);
        showToast('Unarchive failed');
      }
    },
    [setFolders, refreshNotes, showToast],
  );

  const duplicateFolder = useCallback(
    async (id: string) => {
      const copy = await api.duplicateFolder(id);
      setFolders((cur) => {
        const without = cur.filter((f) => f.id !== copy.id);
        return [...without, copy].sort((a, b) => a.position - b.position);
      });
      refreshNotes().catch(console.error);
      refreshTags().catch(console.error);
      setSelectedFolderId(copy.id);
      setView('notes');
    },
    [setFolders, refreshNotes, refreshTags, setSelectedFolderId, setView],
  );

  const moveFolder = useCallback(
    async (id: string, direction: 'up' | 'down') => {
      const fresh = await api.moveFolder(id, direction);
      setFolders(fresh);
    },
    [setFolders],
  );

  const reorderFolders = useCallback(
    async (orderedIds: string[]) => {
      setFolders((cur) => {
        const byId = new Map(cur.map((f) => [f.id, f]));
        return orderedIds
          .map((id, position) => {
            const f = byId.get(id);
            return f ? { ...f, position } : null;
          })
          .filter((f): f is Folder => f !== null);
      });
      const fresh = await api.reorderFolders(orderedIds);
      setFolders(fresh);
    },
    [setFolders],
  );

  /**
   * Copy a paste-into-LLM payload for an entire folder (project):
   * folder id + the titles & ids of every note in it + morion tool
   * hints. Bodies are deliberately omitted — the LLM pulls them via
   * `notes_get` / `notes_list` on demand. Uses the folder's
   * server-side `noteCount` rather than counting allNotes, which is
   * R7-folder-scoped (Sprint 3).
   */
  const shareFolderWithLLM = useCallback(
    async (folderId: string) => {
      const folder = folders.find((f) => f.id === folderId);
      if (!folder) return;
      await copyToClipboard(formatFolderShare(folder, folder.noteCount));
      showToast('Copied');
    },
    [folders, showToast],
  );

  /**
   * Open the unified per-folder settings popup. The optional `tab`
   * argument deep-links to a specific section.
   */
  const openFolderSettings = useCallback(
    (folder: Folder, tab: FolderSettingsTab = 'general') => {
      setFolderSettingsDialog({ folder, tab });
    },
    [setFolderSettingsDialog],
  );

  return {
    createFolder,
    createKanbanFolder,
    renameFolder,
    deleteFolder,
    archiveFolder,
    unarchiveFolder,
    duplicateFolder,
    moveFolder,
    reorderFolders,
    shareFolderWithLLM,
    openFolderSettings,
  };
}
