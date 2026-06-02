import type { Note, NoteSource, NoteStatus } from '../types.js';

/** Raw row shape returned by SELECT statements over the `notes` table.
 *  Mirrors the column list in `queries.ts` (`SELECT_COLUMNS`) — keep in
 *  sync when columns change. */
export interface NoteRow {
  id: string;
  folder_id: string | null;
  title: string;
  body: string;
  pinned: number;
  source: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  archived_at: number | null;
  status: string;
  position: number | null;
  workflow_id: string | null;
  mcp_visible: number | null;
  mcp_update: number | null;
  mcp_delete: number | null;
}

/** SQLite booleans as 0/1/null — fold into the explicit JS tri-state. */
export function tristate(v: number | null): boolean | null {
  if (v === null) return null;
  return v === 1;
}

/** Pure row → Note projection. Tags are passed in (caller owns the
 *  per-id tag lookup so batched reads can amortise). No DB access. */
export function rowToNote(row: NoteRow, tags: string[]): Note {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    body: row.body,
    pinned: row.pinned === 1,
    source: row.source as NoteSource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    archivedAt: row.archived_at,
    status: row.status as NoteStatus,
    position: row.position,
    workflowId: row.workflow_id,
    tags,
    mcpPermissions: {
      visible: tristate(row.mcp_visible),
      update: tristate(row.mcp_update),
      delete: tristate(row.mcp_delete),
    },
  };
}

/**
 * Check if a body already starts with a given title text, accounting for
 * markdown heading prefixes like `# `, `## `, `### `. Used by the
 * fold-title-into-body path to avoid double-prefixing on update.
 */
export function bodyStartsWithTitle(body: string, title: string): boolean {
  const trimmed = body.trimStart();
  if (trimmed.startsWith(title)) return true;
  for (const prefix of ['# ', '## ', '### ']) {
    if (trimmed.startsWith(prefix + title)) return true;
  }
  return false;
}
