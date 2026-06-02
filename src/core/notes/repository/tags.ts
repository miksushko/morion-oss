import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type { Note } from '../types.js';
import { type NoteRow, rowToNote } from './mappers.js';

/**
 * Replace the tag set on a note. Tag rows are looked up or created by name.
 * Caller must wrap in a transaction if multiple writes are batched.
 */
export function setTagsByName(
  db: Database.Database,
  noteId: string,
  tagNames: string[],
): void {
  const upsertTag = db.prepare(
    'INSERT INTO tags (id, name) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
  );
  const lookupTag = db.prepare<[string], { id: string }>(
    'SELECT id FROM tags WHERE name = ?',
  );
  const linkTag = db.prepare(
    'INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
  );

  const seen = new Set<string>();
  for (const raw of tagNames) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    upsertTag.run(ulid(), name);
    const tag = lookupTag.get(name);
    if (tag) linkTag.run(noteId, tag.id);
  }
}

export function tagsForNote(db: Database.Database, noteId: string): string[] {
  const rows = db
    .prepare<[string], { name: string }>(
      `SELECT t.name FROM tags t
       INNER JOIN note_tags nt ON nt.tag_id = t.id
       WHERE nt.note_id = ?
       ORDER BY t.name`,
    )
    .all(noteId);
  return rows.map((r) => r.name);
}

/**
 * Batch variant of `tagsForNote`. Returns a map keyed by noteId with
 * sorted tag-name arrays, one array per requested id. Empty array when
 * a note has no tags.
 *
 * Used by every `list()`-style read (list / recent / listKanban /
 * listTrashed) so we don't fire one `SELECT ... FROM note_tags ...`
 * per row — with a page of 1000 notes that used to be 1001 round-trips
 * (audit R6, 2026-04-17). Now it's always exactly 2: one for notes,
 * one for tags.
 *
 * Returns `new Map()` on an empty input so callers can unconditionally
 * `?? []`-lookup into it.
 */
export function tagsForNoteIds(
  db: Database.Database,
  noteIds: string[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (noteIds.length === 0) return result;
  // Pre-seed with empty arrays so notes with zero tags still show up
  // as an explicit `[]` rather than undefined in the Map.
  for (const id of noteIds) result.set(id, []);

  // SQLite IN-clause needs literal placeholders. All ids come from a
  // row we just read out of `notes` so they're server-trusted — no
  // injection surface.
  const placeholders = noteIds.map(() => '?').join(',');
  const rows = db
    .prepare<string[], { note_id: string; name: string }>(
      `SELECT nt.note_id, t.name
       FROM note_tags nt
       INNER JOIN tags t ON t.id = nt.tag_id
       WHERE nt.note_id IN (${placeholders})
       ORDER BY nt.note_id, t.name`,
    )
    .all(...noteIds);
  for (const row of rows) {
    result.get(row.note_id)!.push(row.name);
  }
  return result;
}

/** Map `NoteRow[]` to `Note[]` with one batched tag lookup. Used by
 * every collection read — replaces the per-row `tagsForNote(row.id)`
 * that caused the N+1 flagged as R6 in the 2026-04-16 review. */
export function rowsToNotes(db: Database.Database, rows: NoteRow[]): Note[] {
  const ids = rows.map((r) => r.id);
  const tagsById = tagsForNoteIds(db, ids);
  return rows.map((row) => rowToNote(row, tagsById.get(row.id) ?? []));
}
