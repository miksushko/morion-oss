import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type { AuditLogger } from '../../audit/log.js';
import { deriveTitleFromBody } from '../title.js';
import type { Note, NoteCreateInput, NoteStatus } from '../types.js';
import { MANUAL_ORDER_STATUSES } from '../types.js';
import { bodyStartsWithTitle } from './mappers.js';
import { setTagsByName } from './tags.js';
import { nextPositionForColumn } from './positions.js';
import { getById } from './read.js';

export function create(
  db: Database.Database,
  audit: AuditLogger,
  input: NoteCreateInput,
  actor: string,
): Note {
  const id = ulid();
  const now = Date.now();

  // Merge legacy title into body if provided and not already the first line
  let body = input.body ?? '';
  if (input.title && input.title.trim()) {
    const trimmedTitle = input.title.trim();
    if (!body.trim() || !bodyStartsWithTitle(body, trimmedTitle)) {
      body = body.trim()
        ? `# ${trimmedTitle}\n\n${body}`
        : trimmedTitle;
    }
  }
  const cachedTitle = deriveTitleFromBody(body);

  // Direction N. Safe default: explicit status only if the client asked
  // for one; otherwise 'note' — which is latent in list-folders and
  // the top rail column in kanban-folders. Position is computed only
  // for manual-order columns (backlog..done); 'note' column sorts by
  // updated_at, no position needed.
  const status: NoteStatus = input.status ?? 'note';
  let position: number | null = null;
  if (MANUAL_ORDER_STATUSES.includes(status)) {
    position = input.position ?? nextPositionForColumn(db, input.folderId ?? null, status);
  }

  const tx = db.transaction(() => {
    db
      .prepare(
        `INSERT INTO notes (id, folder_id, title, body, pinned, source, created_at, updated_at, deleted_at, status, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.folderId ?? null,
        cachedTitle,
        body,
        input.pinned ? 1 : 0,
        input.source,
        now,
        now,
        status,
        position,
      );

    if (input.tags && input.tags.length > 0) {
      setTagsByName(db, id, input.tags);
    }
  });
  tx();

  audit.record({ noteId: id, action: 'create', actor });
  return getById(db, audit, id, { audit: false, actor })!;
}
