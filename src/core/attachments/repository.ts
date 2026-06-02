import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type { Attachment } from './types.js';

interface AttachmentRow {
  id: string;
  note_id: string;
  file_path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  created_at: number;
  width: number | null;
  height: number | null;
}

export interface AttachmentCreateInput {
  /** Owning note. Cascade on hard-delete drops the row automatically. */
  noteId: string;
  /** Absolute path to the file on disk. Repo stores as-is; callers own the
   * write-to-disk + rename dance. */
  filePath: string;
  /** Sniffed MIME from the file header (not the Content-Type client sent). */
  mimeType: string;
  sizeBytes: number;
  /** Hex-encoded sha256 of the file bytes. Used for integrity checks, not
   * for dedup — two notes pasting the same screenshot get two rows + two
   * files in v1. Refcount-style dedup deferred. */
  sha256: string;
  /** Optional pixel dimensions; null for images where probe failed or for
   * future non-image attachments. */
  width?: number | null;
  height?: number | null;
}

/**
 * CRUD on the `attachments` table. File-system work (write, unlink) lives
 * in the route handlers — keeping the repo pure-SQL mirrors every other
 * Morion repository.
 *
 * Cascade note: `ON DELETE CASCADE` on `note_id` means a hard-purge of a
 * note wipes its attachment rows for free. Files on disk aren't touched
 * by SQLite — the caller must collect `pathsForNotes(ids)` BEFORE the
 * DELETE, then unlink after. See `src/server/routes/notes.ts` purge
 * handlers (Direction P hookup).
 */
export class AttachmentsRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: AttachmentCreateInput): Attachment {
    return this.createWithId({ ...input, id: ulid() });
  }

  /**
   * Create an attachment row using a pre-allocated id. Used by the
   * import path where the id needs to be embedded in the markdown
   * body (`morion://attachment/<id>`) BEFORE the SQL row exists —
   * we allocate the id, write bytes to disk + bake the URL into the
   * body, then insert the row once the owning note id is known.
   *
   * Regular create path stays the same; this is just an explicit-id
   * overload.
   */
  createWithId(input: AttachmentCreateInput & { id: string }): Attachment {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO attachments
           (id, note_id, file_path, mime_type, size_bytes, sha256,
            created_at, width, height)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.noteId,
        input.filePath,
        input.mimeType,
        input.sizeBytes,
        input.sha256,
        now,
        input.width ?? null,
        input.height ?? null,
      );
    return {
      id: input.id,
      noteId: input.noteId,
      filePath: input.filePath,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      createdAt: now,
      width: input.width ?? null,
      height: input.height ?? null,
    };
  }

  getById(id: string): Attachment | null {
    const row = this.db
      .prepare<[string], AttachmentRow>(
        'SELECT id, note_id, file_path, mime_type, size_bytes, sha256, created_at, width, height FROM attachments WHERE id = ?',
      )
      .get(id);
    return row ? this.rowToAttachment(row) : null;
  }

  listByNoteId(noteId: string): Attachment[] {
    const rows = this.db
      .prepare<[string], AttachmentRow>(
        `SELECT id, note_id, file_path, mime_type, size_bytes, sha256, created_at, width, height
         FROM attachments
         WHERE note_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(noteId);
    return rows.map((r) => this.rowToAttachment(r));
  }

  /**
   * File-system cleanup helper: given a set of note ids about to be
   * hard-deleted, return every `file_path` whose row will be cascaded
   * so the caller can unlink them AFTER the DELETE transaction commits.
   *
   * Must be called BEFORE the note DELETE — once the note row is gone
   * the cascade has already taken its attachment rows with it and this
   * query would return nothing.
   */
  pathsForNotes(noteIds: string[]): string[] {
    if (noteIds.length === 0) return [];
    const placeholders = noteIds.map(() => '?').join(',');
    const rows = this.db
      .prepare<string[], { file_path: string }>(
        `SELECT file_path FROM attachments WHERE note_id IN (${placeholders})`,
      )
      .all(...noteIds);
    return rows.map((r) => r.file_path);
  }

  /**
   * Direct single-id delete (for Phase 3's `DELETE /api/attachments/:id`).
   * Returns the file_path that now needs to be unlinked, or null if the
   * id didn't exist.
   */
  deleteById(id: string): string | null {
    const row = this.db
      .prepare<[string], { file_path: string }>(
        'SELECT file_path FROM attachments WHERE id = ?',
      )
      .get(id);
    if (!row) return null;
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    return row.file_path;
  }

  private rowToAttachment(row: AttachmentRow): Attachment {
    return {
      id: row.id,
      noteId: row.note_id,
      filePath: row.file_path,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      createdAt: row.created_at,
      width: row.width,
      height: row.height,
    };
  }
}
