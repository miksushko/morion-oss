import type Database from 'better-sqlite3';
import type { AuditLogger } from '../../audit/log.js';
import type { Note, NoteListFilters } from '../types.js';
import { type NoteRow, rowToNote } from './mappers.js';
import { SELECT_COLUMNS, SELECT_COLUMNS_N } from './queries.js';
import { rowsToNotes, tagsForNote } from './tags.js';

export function getById(
  db: Database.Database,
  audit: AuditLogger,
  id: string,
  options: { audit?: boolean; actor?: string; includeTrashed?: boolean } = {},
): Note | null {
  const sql = options.includeTrashed
    ? `SELECT ${SELECT_COLUMNS} FROM notes WHERE id = ?`
    : `SELECT ${SELECT_COLUMNS} FROM notes WHERE id = ? AND deleted_at IS NULL`;
  const row = db.prepare<[string], NoteRow>(sql).get(id);
  if (!row) return null;

  const tags = tagsForNote(db, id);

  if (options.audit && options.actor) {
    audit.record({ noteId: id, action: 'read', actor: options.actor });
  }
  return rowToNote(row, tags);
}

export function list(db: Database.Database, filters: NoteListFilters): Note[] {
  const { sql, params } = buildListQuery(filters, false);
  const rows = db.prepare(sql).all(...params) as NoteRow[];
  return rowsToNotes(db, rows);
}

/**
 * Total count of notes that match the same filters as `list()` (minus
 * limit/offset). Used by the UI to decide whether to show a "showing N of
 * M" hint and by anyone who needs to reason about the full notebook size
 * without paginating through it.
 */
export function count(
  db: Database.Database,
  filters: Omit<NoteListFilters, 'limit' | 'offset'>,
): number {
  const { sql, params } = buildListQuery(
    { ...filters, limit: 0, offset: 0 },
    true,
  );
  const row = db.prepare(sql).get(...params) as { total: number } | undefined;
  return row?.total ?? 0;
}

/**
 * Last `limit` non-deleted notes by `updated_at` desc, intentionally
 * pin-agnostic. `list()` always sorts pinned first, which is correct for
 * the sidebar but wrong for "what was I working on yesterday?" — `recent()`
 * answers the second question.
 */
export function recent(
  db: Database.Database,
  limit: number,
  options?: { includeArchived?: boolean; includeMoSystem?: boolean },
): Note[] {
  const includeArchived = options?.includeArchived === true;
  const includeMoSystem = options?.includeMoSystem === true;
  const moSystemFilter = includeMoSystem
    ? ''
    : ` AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')`;
  const sql = includeArchived
    ? `SELECT ${SELECT_COLUMNS_N} FROM notes n
       WHERE n.deleted_at IS NULL ${moSystemFilter}
       ORDER BY n.updated_at DESC
       LIMIT ?`
    : `SELECT ${SELECT_COLUMNS_N} FROM notes n
       LEFT JOIN folders f ON f.id = n.folder_id
       WHERE n.deleted_at IS NULL
         AND n.archived_at IS NULL
         AND (f.id IS NULL OR f.archived_at IS NULL) ${moSystemFilter}
       ORDER BY n.updated_at DESC
       LIMIT ?`;
  const rows = db.prepare(sql).all(limit) as NoteRow[];
  return rowsToNotes(db, rows);
}

function buildListQuery(
  filters: NoteListFilters,
  countOnly: boolean,
): { sql: string; params: (string | number)[] } {
  const conditions: string[] = ['n.deleted_at IS NULL'];
  const params: (string | number)[] = [];

  if (filters.folderId !== undefined) {
    if (filters.folderId === null) {
      conditions.push('n.folder_id IS NULL');
    } else {
      conditions.push('n.folder_id = ?');
      params.push(filters.folderId);
    }
  }
  if (filters.pinned !== undefined) {
    conditions.push('n.pinned = ?');
    params.push(filters.pinned ? 1 : 0);
  }

  // Archive filter. `includeArchived:false` (default) drops both:
  //  (a) notes with their own `archived_at` set, and
  //  (b) notes whose folder is archived — even if the note itself
  //      hasn't been archived individually. Folder archive hides the
  //      whole board, so its cards must stay hidden regardless of
  //      whether the viewer asked for a folder filter.
  const includeArchived = filters.includeArchived === true;

  let sql = countOnly
    ? `SELECT COUNT(*) AS total FROM notes n `
    : `SELECT ${SELECT_COLUMNS_N} FROM notes n `;

  if (filters.tag) {
    sql += `
      INNER JOIN note_tags nt ON nt.note_id = n.id
      INNER JOIN tags t ON t.id = nt.tag_id
    `;
    conditions.push('t.name = ?');
    params.push(filters.tag);
  }

  if (!includeArchived) {
    // LEFT JOIN so unfiled notes (folder_id IS NULL) aren't dropped.
    sql += ` LEFT JOIN folders f ON f.id = n.folder_id `;
    conditions.push('n.archived_at IS NULL');
    conditions.push('(f.id IS NULL OR f.archived_at IS NULL)');
  }

  // Phase 6.7 v2 — `mo:*` system notes (catalog, cluster:<theme>,
  // risks, patrol-log) are auto-maintained machine-readable
  // indices surfaced through the Folder Settings dialog tabs.
  // Hide them from user-facing notes lists by default so the
  // sidebar / list view doesn't show "mo:cluster:kanban-ui",
  // "mo:cluster:auth-token-management", etc. Power users debugging
  // the indexing pipeline can set `includeMoSystem: true`.
  const includeMoSystem = filters.includeMoSystem === true;
  if (!includeMoSystem) {
    conditions.push(
      "(n.source IS NULL OR n.source NOT LIKE 'mo:%')",
    );
  }

  sql += ` WHERE ${conditions.join(' AND ')} `;

  if (!countOnly) {
    sql += ' ORDER BY n.pinned DESC, n.updated_at DESC ';
    sql += ' LIMIT ? OFFSET ?';
    params.push(filters.limit, filters.offset);
  }

  return { sql, params };
}
