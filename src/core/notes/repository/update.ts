import type Database from 'better-sqlite3';
import type { AuditLogger } from '../../audit/log.js';
import { deriveTitleFromBody } from '../title.js';
import type { Note, NoteUpdateInput } from '../types.js';
import { bodyStartsWithTitle } from './mappers.js';
import { setTagsByName } from './tags.js';
import { getById } from './read.js';

/**
 * Apple Notes parity: only `body` changes are content edits that bump
 * `updated_at`. Folder moves, pin toggles, and tag changes are organisational
 * metadata — they update the row but leave `updated_at` alone, so the moved
 * note keeps its position in the date-sorted list instead of jumping to the
 * top of its new folder.
 *
 * Title is derived from the first line of body — never set independently.
 * A legacy `title` field in the patch is merged into the body (backwards compat
 * for MCP clients). A body patch whose value equals the current row is NOT a
 * content edit — prevents the editor's external sync from bumping updatedAt.
 */
export function update(
  db: Database.Database,
  audit: AuditLogger,
  id: string,
  input: NoteUpdateInput,
  actor: string,
): Note | null {
  const existing = getById(db, audit, id);
  if (!existing) return null;

  // Resolve the effective body, merging legacy title if provided
  let newBody: string | undefined = input.body;
  if (input.title !== undefined && input.title.trim()) {
    const base = newBody ?? existing.body;
    const trimmedTitle = input.title.trim();
    if (!bodyStartsWithTitle(base, trimmedTitle)) {
      newBody = base.trim()
        ? `# ${trimmedTitle}\n\n${base}`
        : trimmedTitle;
    }
  }

  const bodyChanged = newBody !== undefined && newBody !== existing.body;

  const fields: string[] = [];
  const params: (string | number | null)[] = [];
  const isContentEdit = bodyChanged;

  if (bodyChanged) {
    fields.push('body = ?');
    params.push(newBody!);
    fields.push('title = ?');
    params.push(deriveTitleFromBody(newBody!));
  }
  if (input.folderId !== undefined) {
    fields.push('folder_id = ?');
    params.push(input.folderId);
  }
  if (input.pinned !== undefined) {
    fields.push('pinned = ?');
    params.push(input.pinned ? 1 : 0);
  }

  // Direction N — status / position patches via notes_update are supported
  // for backwards compat (MCP clients that know the schema but not the
  // dedicated tasks_* tools). They're metadata, so they do NOT bump
  // updated_at. A status change writes an audit_log row with the transition
  // — omitting that would silently drop history for every tasks_move done
  // through the legacy path.
  const statusChanged =
    input.status !== undefined && input.status !== existing.status;
  if (input.status !== undefined) {
    fields.push('status = ?');
    params.push(input.status);
  }
  if (input.position !== undefined) {
    fields.push('position = ?');
    params.push(input.position);
  }

  // Per-ticket Auto-code workflow override (ticket
  // 01KRWQPDKQ2RZMDBJZ5KN0B7YE). Metadata field — no `updated_at`
  // bump (same rationale as status / position). The repo writes the
  // value verbatim; folder-ownership + template-existence checks
  // live at the resolver / route boundary.
  if (input.workflowId !== undefined) {
    fields.push('workflow_id = ?');
    params.push(input.workflowId);
  }

  const tx = db.transaction(() => {
    if (fields.length > 0) {
      if (isContentEdit) {
        fields.push('updated_at = ?');
        params.push(Date.now());
      }
      params.push(id);
      db.prepare(`UPDATE notes SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    }

    if (input.tags !== undefined) {
      db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(id);
      if (input.tags.length > 0) setTagsByName(db, id, input.tags);
    }

    if (statusChanged) {
      audit.recordStatusChange({
        noteId: id,
        actor,
        statusFrom: existing.status,
        statusTo: input.status!,
      });
    }
  });
  tx();

  audit.record({ noteId: id, action: 'update', actor });
  return getById(db, audit, id);
}
