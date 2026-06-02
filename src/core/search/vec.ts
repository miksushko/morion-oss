import type Database from 'better-sqlite3';

export interface VecHit {
  noteId: string;
  distance: number;
}

interface VecRow {
  note_id: string;
  distance: number;
}

/**
 * Wrapper around the notes_vec virtual table provided by sqlite-vec.
 * All methods are no-ops when the extension wasn't loaded.
 */
export class VecIndex {
  constructor(
    private readonly db: Database.Database,
    private readonly enabled: boolean,
  ) {}

  upsert(noteId: string, embedding: Float32Array): void {
    if (!this.enabled) return;
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    // sqlite-vec's vec0 virtual table doesn't honour INSERT OR REPLACE — it
    // raises "UNIQUE constraint failed" on the note_id primary key. Delete
    // any existing row first, then insert. Wrapped in a transaction so a
    // crash between the two statements can't orphan the note from its
    // embedding.
    //
    // Guard against N19 (2026-04-16): reindex is fire-and-forget and
    // embedding inference takes ~100 ms; a note can be soft-deleted OR
    // hard-purged between the async embed() and this upsert. Without
    // the EXISTS check we'd write an embedding for a note the vec
    // index has no corresponding row for, which shows up as a stale
    // hit in HybridSearch until the next full rebuild.
    const tx = this.db.transaction(() => {
      const live = this.db
        .prepare<[string], { one: 1 }>(
          'SELECT 1 AS one FROM notes WHERE id = ? AND deleted_at IS NULL',
        )
        .get(noteId);
      if (!live) return;
      this.db.prepare('DELETE FROM notes_vec WHERE note_id = ?').run(noteId);
      this.db
        .prepare('INSERT INTO notes_vec (note_id, embedding) VALUES (?, ?)')
        .run(noteId, buf);
    });
    tx();
  }

  delete(noteId: string): void {
    if (!this.enabled) return;
    this.db.prepare('DELETE FROM notes_vec WHERE note_id = ?').run(noteId);
  }

  search(embedding: Float32Array, limit: number): VecHit[] {
    if (!this.enabled) return [];
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    // Filter out soft-deleted notes via a join.
    const rows = this.db
      .prepare<[Buffer, number], VecRow>(
        `SELECT v.note_id AS note_id, v.distance AS distance
         FROM notes_vec v
         JOIN notes n ON n.id = v.note_id
         WHERE v.embedding MATCH ? AND k = ? AND n.deleted_at IS NULL
         ORDER BY v.distance`,
      )
      .all(buf, limit);
    return rows.map((r) => ({ noteId: r.note_id, distance: r.distance }));
  }
}
