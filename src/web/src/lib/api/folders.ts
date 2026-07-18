import { request } from './http';
import type {
  Folder,
  FolderMcpPermissions,
  FolderViewMode,
  KanbanBoard,
  Note,
  NoteMcpPermissions,
  NoteStatus,
} from './types';

/**
 * Folder CRUD + per-folder kanban view + MCP permissions.
 *
 * Note-permission writes live here too because they share the
 * `<folder>/<note>/permissions` URL family — the UI surface that owns
 * them is the folder MCP-permissions dialog.
 */
export const foldersApi = {
  listFolders: (options?: { includeArchived?: boolean }) =>
    request<Folder[]>(
      options?.includeArchived ? '/api/folders?includeArchived=1' : '/api/folders',
    ),
  archiveFolder: (id: string) =>
    request<Folder>(`/api/folders/${id}/archive`, { method: 'POST' }),
  unarchiveFolder: (id: string) =>
    request<Folder>(`/api/folders/${id}/unarchive`, { method: 'POST' }),
  createFolder: (name: string, parentId: string | null = null) =>
    request<Folder>('/api/folders', { method: 'POST', body: JSON.stringify({ name, parentId }) }),
  renameFolder: (id: string, name: string) =>
    request<Folder>(`/api/folders/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  // Deleting a folder moves its notes to Trash by default. Pass
  // { keepNotes: true } to instead leave them as unfiled notes.
  deleteFolder: (id: string, opts: { keepNotes?: boolean } = {}) =>
    request<{ ok: boolean; trashedNoteCount: number }>(
      `/api/folders/${id}${opts.keepNotes ? '?keepNotes=true' : ''}`,
      { method: 'DELETE' },
    ),
  reorderFolders: (orderedIds: string[]) =>
    request<Folder[]>('/api/folders/reorder', {
      method: 'PATCH',
      body: JSON.stringify({ orderedIds }),
    }),
  duplicateFolder: (id: string) =>
    request<Folder>(`/api/folders/${id}/duplicate`, { method: 'POST' }),
  moveFolder: (id: string, direction: 'up' | 'down') =>
    request<Folder[]>(`/api/folders/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ direction }),
    }),
  setFolderPermissions: (folderId: string, perms: FolderMcpPermissions) =>
    request<Folder>(`/api/folders/${folderId}/permissions`, {
      method: 'PUT',
      body: JSON.stringify(perms),
    }),
  setNotePermissions: (noteId: string, perms: NoteMcpPermissions) =>
    request<Note>(`/api/notes/${noteId}/permissions`, {
      method: 'PUT',
      body: JSON.stringify(perms),
    }),
  // Kanban (Direction N) — UI-side endpoints. The MCP tool layer exposes
  // the same primitives via tasks_*; both go through the same repo methods
  // so status_change audit rows are consistent.
  setFolderViewMode: (folderId: string, viewMode: FolderViewMode) =>
    request<Folder>(`/api/folders/${folderId}/view-mode`, {
      method: 'PATCH',
      body: JSON.stringify({ viewMode }),
    }),
  getKanban: (folderId: string) =>
    request<KanbanBoard>(`/api/folders/${folderId}/kanban`),
  moveTaskInKanban: (
    noteId: string,
    input: { status: NoteStatus; afterNoteId?: string | null },
  ) =>
    // The response is the moved note, plus an optional `autoCode` field
    // when a drag INTO `todo` triggered an auto-code enqueue that was
    // rejected for a user-actionable reason (repo missing, agent not
    // installed, …) — the UI flashes `autoCode.message` so the ticket
    // doesn't silently sit in `todo`. Absent on success / non-auto-code
    // folders / non-todo moves.
    request<Note & { autoCode?: { ok: false; reason: string; message: string } }>(
      `/api/notes/${noteId}/kanban-move`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
};
