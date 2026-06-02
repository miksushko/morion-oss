/**
 * Archive-visibility gate for MCP tools.
 *
 * Ticket 01KPGNY92RPYA4AEPC32C9HH0P #5 — archived notes + folders are
 * unreachable from MCP, including direct-id access. The surface spec
 * says "как будто их нет", so we return `note_not_found` /
 * `folder_not_found` envelopes from tool handlers rather than a
 * dedicated `archived` error — the agent should treat these rows as
 * non-existent.
 *
 * UI bypasses this gate entirely (SettingsPanel "Show Archived" toggle
 * passes includeArchived=true at the HTTP boundary; direct-id get in
 * the UI doesn't check archived state). Only MCP callers go through
 * these helpers.
 *
 * For collection reads, the repo's default `includeArchived:false` is
 * what hides them — MCP tools never opt in. For direct-id reads +
 * mutations, tools call `isNoteMcpHidden` / `isFolderMcpHidden` after
 * the repo fetch.
 */

import type { Folder, Note } from '../notes/types.js';
import type { FoldersRepository } from '../folders/repository.js';

/**
 * True if the note should be invisible to MCP — either itself archived
 * OR living inside an archived folder. Call AFTER
 * `NotesRepository.getById(id)` returns a non-null note, before the
 * tool handler uses it.
 */
export function isNoteMcpHidden(
  note: Note,
  ctx: { folders: FoldersRepository },
): boolean {
  if (note.archivedAt != null) return true;
  if (note.folderId != null) {
    const folder = ctx.folders.getById(note.folderId);
    if (folder && folder.archivedAt != null) return true;
  }
  return false;
}

export function isFolderMcpHidden(folder: Folder): boolean {
  return folder.archivedAt != null;
}

/**
 * Drop archived notes and notes-in-archived-folders from a collection
 * returned by a repo call. Use after `filterReadable` for MCP
 * collection tools (`notes_list`, `notes_recent`, `notes_search`,
 * `tasks_list`).
 *
 * The repo-level default already filters archived notes; this helper
 * is defence-in-depth + handles the "note's own archived_at is null
 * but its folder is archived" path that `ctx.notes.list(...)` also
 * covers via LEFT JOIN. One batched folder lookup keeps the cost at
 * O(N) in notes + O(1) folder scan.
 */
export function filterArchivedFromMcp<T extends Note>(
  notes: T[],
  ctx: { folders: FoldersRepository },
): T[] {
  if (notes.length === 0) return notes;
  const archivedFolderIds = new Set<string>();
  for (const folder of ctx.folders.list({ includeArchived: true })) {
    if (folder.archivedAt != null) archivedFolderIds.add(folder.id);
  }
  return notes.filter((n) => {
    if (n.archivedAt != null) return false;
    if (n.folderId != null && archivedFolderIds.has(n.folderId)) return false;
    return true;
  });
}
