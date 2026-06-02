import { fetchOrThrow, request } from './http';
import type {
  ActivityPage,
  ListNotesResult,
  Note,
  NoteClusterAssignment,
  NoteComment,
  NoteMetadataPayload,
  NoteRevision,
  NoteStatus,
  StatusHistoryEntry,
} from './types';

/**
 * Note CRUD + trash + archive + revisions + comments + activity feed +
 * inline attachments + per-note metadata/clusters + status history.
 *
 * All these endpoints share the `/api/notes/...` (or note-derived
 * `/api/comments/`, `/api/attachments/`) URL family and operate on a
 * single note's lifecycle.
 */
export const notesApi = {
  listNotes: async (
    params: {
      folderId?: string;
      tag?: string;
      limit?: number;
      offset?: number;
      includeArchived?: boolean;
    } = {},
  ): Promise<ListNotesResult> => {
    const qs = new URLSearchParams();
    if (params.folderId) qs.set('folderId', params.folderId);
    if (params.tag) qs.set('tag', params.tag);
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.offset !== undefined) qs.set('offset', String(params.offset));
    if (params.includeArchived) qs.set('includeArchived', '1');
    const path = qs.toString() ? `/api/notes?${qs}` : '/api/notes';
    const res = await fetchOrThrow(path);
    const notes = (await res.json()) as Note[];
    const totalHeader = res.headers.get('X-Total-Count');
    const total = totalHeader ? Number.parseInt(totalHeader, 10) : notes.length;
    return { notes, total: Number.isFinite(total) ? total : notes.length };
  },
  /**
   * Unfiltered count of live notes, read from X-Total-Count so the payload
   * stays tiny. Used for the "All notes" counter in Sidebar — `listNotes`'
   * total reflects the current folder filter after R7, which isn't what
   * "all notes" should show.
   */
  getAllNotesCount: async (): Promise<number> => {
    const res = await fetchOrThrow('/api/notes?limit=1&offset=0');
    await res.text();
    const h = res.headers.get('X-Total-Count');
    const n = h ? Number.parseInt(h, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  },
  getNote: (id: string) => request<Note>(`/api/notes/${id}`),
  createNote: (input: {
    body?: string;
    folderId?: string | null;
    tags?: string[];
    status?: NoteStatus;
    position?: number | null;
  }) =>
    request<Note>('/api/notes', { method: 'POST', body: JSON.stringify(input) }),
  updateNote: (
    id: string,
    patch: Partial<{
      body: string;
      folderId: string | null;
      tags: string[];
      pinned: boolean;
      status: NoteStatus;
      position: number | null;
      /** Per-ticket Auto-code workflow override (ticket
       *  01KRWQPDKQ2RZMDBJZ5KN0B7YE). Null = clear the override. */
      workflowId: string | null;
    }>,
  ) => request<Note>(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteNote: (id: string) => request<{ ok: boolean }>(`/api/notes/${id}`, { method: 'DELETE' }),
  /** Archive (hide from default lists + MCP; recoverable via unarchive). */
  archiveNote: (id: string) =>
    request<Note>(`/api/notes/${id}/archive`, { method: 'POST' }),
  unarchiveNote: (id: string) =>
    request<Note>(`/api/notes/${id}/unarchive`, { method: 'POST' }),
  listTrash: () => request<Note[]>('/api/notes/trash'),
  restoreNote: (id: string) =>
    request<Note>(`/api/notes/${id}/restore`, { method: 'POST' }),
  /** Permanently delete a single trashed note. Server refuses live notes. */
  purgeNote: (id: string) =>
    request<{ ok: boolean }>(`/api/notes/${id}/purge`, { method: 'DELETE' }),
  /** Empty the trash — hard-delete every soft-deleted note. */
  emptyTrash: () => request<{ purged: number }>('/api/notes/trash', { method: 'DELETE' }),

  // Note revisions (version history) — see src/core/revisions/repository.ts
  // for the 3-recent + 1-baseline retention policy. The UI surfaces this
  // through a popover anchored to the editor footer's "Edited X" button.
  listRevisions: (noteId: string) =>
    request<NoteRevision[]>(`/api/notes/${noteId}/revisions`),
  /** Manual snapshot, fired by App.tsx on navigate-away. */
  createRevision: (noteId: string) =>
    request<NoteRevision>(`/api/notes/${noteId}/revisions`, { method: 'POST' }),
  restoreRevision: (noteId: string, revisionId: string) =>
    request<Note>(`/api/notes/${noteId}/revisions/${revisionId}/restore`, {
      method: 'POST',
    }),

  getStatusHistory: (noteId: string, limit = 50) =>
    request<StatusHistoryEntry[]>(
      `/api/notes/${noteId}/status-history?limit=${limit}`,
    ),

  // Direction P — inline image attachments.
  //
  // Upload posts multipart/form-data; the server handles the multipart
  // parse, magic-byte sniff, 10 MB cap, and atomic disk write. The
  // response carries the stable `morion://attachment/<id>` URL that
  // we then insert into the Tiptap Image node.
  //
  // Fetch returns a Blob so the node view can `URL.createObjectURL`
  // it and hand the result to `<img src>`. CSP blocks
  // `http://127.0.0.1:*` in img-src but allows `blob:` — this two-step
  // is what makes inline images work inside the Tauri webview.
  uploadAttachment: async (
    file: File,
    noteId: string,
  ): Promise<{
    id: string;
    url: string;
    mimeType: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
  }> => {
    const form = new FormData();
    form.append('file', file, file.name);
    const res = await fetchOrThrow(
      `/api/attachments?noteId=${encodeURIComponent(noteId)}`,
      { method: 'POST', body: form },
    );
    return (await res.json()) as {
      id: string;
      url: string;
      mimeType: string;
      sizeBytes: number;
      width: number | null;
      height: number | null;
    };
  },
  fetchAttachment: async (id: string): Promise<Blob> => {
    const res = await fetchOrThrow(`/api/attachments/${id}`);
    return await res.blob();
  },

  // ---------------------------------------------------------------
  // Direction Q — activity feed + comments CRUD
  // ---------------------------------------------------------------

  /**
   * Fetch a page of the unified activity feed for a note. Pass `cursor`
   * from the previous response's `nextCursor` to paginate older pages.
   * Default `limit` 20 (matches UI "Show more" batch size).
   */
  listActivity: async (
    noteId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<ActivityPage> => {
    const params = new URLSearchParams();
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString();
    const res = await fetchOrThrow(
      `/api/notes/${encodeURIComponent(noteId)}/activity${qs ? `?${qs}` : ''}`,
    );
    return (await res.json()) as ActivityPage;
  },

  /** Post a new comment on a note, or a 1-level reply. */
  addComment: async (
    noteId: string,
    body: string,
    parentId?: string,
  ): Promise<NoteComment> => {
    const res = await fetchOrThrow(
      `/api/notes/${encodeURIComponent(noteId)}/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, parentId: parentId ?? null }),
      },
    );
    return (await res.json()) as NoteComment;
  },

  /** Edit a comment you authored. Server enforces actor-match. */
  updateComment: async (commentId: string, body: string): Promise<NoteComment> => {
    const res = await fetchOrThrow(`/api/comments/${encodeURIComponent(commentId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    return (await res.json()) as NoteComment;
  },

  /** Delete a comment you authored. Cascades to its replies. */
  deleteComment: async (commentId: string): Promise<{ ok: true }> => {
    const res = await fetchOrThrow(`/api/comments/${encodeURIComponent(commentId)}`, {
      method: 'DELETE',
    });
    return (await res.json()) as { ok: true };
  },

  getNoteMetadata: async (noteId: string): Promise<NoteMetadataPayload> => {
    const res = await fetchOrThrow(
      `/api/notes/${encodeURIComponent(noteId)}/metadata`,
    );
    return (await res.json()) as NoteMetadataPayload;
  },

  patchNoteMetadata: async (
    noteId: string,
    patch: { moHandsOff?: boolean },
  ): Promise<NoteMetadataPayload> => {
    const res = await fetchOrThrow(
      `/api/notes/${encodeURIComponent(noteId)}/metadata`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    );
    return (await res.json()) as NoteMetadataPayload;
  },

  putNoteClusters: async (
    noteId: string,
    clusters: string[],
  ): Promise<{ noteId: string; clusters: NoteClusterAssignment[] }> => {
    const res = await fetchOrThrow(
      `/api/notes/${encodeURIComponent(noteId)}/clusters`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusters }),
      },
    );
    return (await res.json()) as {
      noteId: string;
      clusters: NoteClusterAssignment[];
    };
  },
};
