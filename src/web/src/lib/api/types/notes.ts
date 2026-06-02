/**
 * Notes domain types — Note, kanban status enum, comments, unified
 * activity feed, status history, revisions, list pagination,
 * per-note MCP permissions, per-note Mo Indexing metadata + clusters.
 *
 * NoteMcpPermissions lives here (not in folders.ts) so the Note
 * interface can reference it without a cross-module import.
 */

/** Kanban column membership. `note` is the safe default (reference /
 * idea on the shelf), `backlog` is executable work queued up. */
export const NOTE_STATUSES = ['note', 'backlog', 'todo', 'doing', 'review', 'done'] as const;

export type NoteStatus = (typeof NOTE_STATUSES)[number];

export interface Note {
  id: string;
  folderId: string | null;
  title: string;
  body: string;
  pinned: boolean;
  source: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /** Archive timestamp — non-null means the user archived this note.
   * Archived notes are hidden from default lists + MCP; surfaced only
   * when the UI "Show Archived" toggle is on, with a muted label. */
  archivedAt: number | null;
  /** Direction N — kanban column. Always present; `note` in list-folders. */
  status: NoteStatus;
  /** Manual order within a kanban column. Null in `note` column + list-folders. */
  position: number | null;
  /** Per-ticket Auto-code workflow override (ticket
   *  01KRWQPDKQ2RZMDBJZ5KN0B7YE). Built-in template id (e.g. "default")
   *  OR a `workflows` row ULID owned by the same folder. Null = "use
   *  folder default". */
  workflowId: string | null;
  tags: string[];
  mcpPermissions: NoteMcpPermissions;
  /** Direction Q — populated only in the kanban board response
   * (`GET /api/folders/:id/kanban`). Other endpoints (notes_list, etc.)
   * omit the field; the badge renderer treats `undefined` same as 0. */
  commentCount?: number;
}

export interface StatusHistoryEntry {
  id: number;
  noteId: string;
  actor: string;
  timestamp: number;
  statusFrom: NoteStatus;
  statusTo: NoteStatus;
}

/** Direction Q — a single free-form comment on a note. */
export interface NoteComment {
  id: string;
  noteId: string;
  parentId: string | null;
  body: string;
  actor: string;
  createdAt: number;
  /** Non-null when the comment has been edited after initial post. */
  updatedAt: number | null;
}

/** Direction Q — unified activity row. The panel renders events + comments
 *  in one chronological stream; the `kind` tag drives the variant. */
export type ActivityRow =
  | {
      kind: 'event';
      action: 'create' | 'update' | 'delete' | 'status_change' | 'comment_delete';
      noteId: string;
      actor: string;
      ts: number;
      statusFrom?: string;
      statusTo?: string;
    }

/** Activity-feed response shape (Direction Q). */
export interface ActivityPage {
  items: ActivityRow[];
  /** Opaque cursor string — pass back verbatim in `cursor` to fetch next page. */
  nextCursor: string | null;
  /** Total across both streams for this note (drives "Show N events" label + badge). */
  total: number;
}

/** Per-note overrides — null means "inherit from folder". No `create`
 * because notes can't contain notes. */
export interface NoteMcpPermissions {
  visible: boolean | null;
  update: boolean | null;
  delete: boolean | null;
}

export type RevisionKind = 'recent' | 'baseline';

export interface NoteRevision {
  id: string;
  noteId: string;
  title: string;
  body: string;
  tagIds: string[];
  folderId: string | null;
  actor: string;
  createdAt: number;
  kind: RevisionKind;
}

export interface ListNotesResult {
  notes: Note[];
  total: number;
}

/** Phase 6.5 — per-note metadata payload backing the Note Meta Data
 *  panel. `metadata` is null when no Tier 1 has run for the note yet
 *  (fresh note, indexing tick hasn't reached it). */
export interface NoteMoMetadataDto {
  noteId: string;
  summary: string;
  keywords: string[];
  bodyHash: string | null;
  computedBy: string | null;
  computedAt: number | null;
  confidence: number | null;
  moHandsOff: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NoteClusterAssignment {
  noteId: string;
  clusterId: string;
  confidence: number;
  source: 'tier0' | 'tier1' | 'user' | 'imported' | 'verified';
  updatedAt: number;
}

export interface NoteMetadataPayload {
  noteId: string;
  metadata: NoteMoMetadataDto | null;
  clusters: NoteClusterAssignment[];
}
