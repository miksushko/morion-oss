import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import {
  CommentActorMismatchError,
  NestedReplyError,
  type CommentCursor,
  type NoteComment,
  type NoteCommentListPage,
} from './comments-types.js';

// Monotonic ulid so two posts in the same millisecond stay ordered.
// Same motivation as RevisionsRepository — the activity union relies on
// deterministic tie-break via (created_at, id) DESC, and chatty-agent
// scenarios can easily land two comments in the same tick.
const ulid = monotonicFactory();

interface CommentRow {
  id: string;
  note_id: string;
  parent_id: string | null;
  body: string;
  actor: string;
  created_at: number;
  updated_at: number | null;
}

/**
 * Free-form posts against a note. 1-level reply threading (reply-to-reply
 * rejected at create time). No retention — comments are the audit trail, see
 * lesson 2026-04-17 «Three separate timelines».
 *
 * Actor-match on update/delete is enforced HERE (not only at the Q2 auth
 * layer) as defense-in-depth: if a future codepath calls the repo bypassing
 * the tool/HTTP gate, a wrong-actor mutation still throws.
 *
 * Cursor pagination via `before = created_at` — O(log n) at any depth because
 * of `idx_note_comments_note(note_id, created_at)`. Same pattern the Q2
 * activity union will reuse.
 */
export class NoteCommentsRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Create a new comment (or reply). Returns `null` if `noteId` doesn't
   * exist or is soft-deleted — callers should treat this like 404. Throws
   * `NestedReplyError` if `parentId` refers to a comment that itself has a
   * non-null parent.
   *
   * Runs in a transaction so a concurrent delete-parent can't slip between
   * the parent-lookup and the insert and leave us with a reply pointing at
   * a row that's already been reaped.
   */
  create(noteId: string, body: string, actor: string, parentId?: string | null): NoteComment | null {
    let createdId: string | null = null;

    const tx = this.db.transaction(() => {
      // 1. Note must exist and be live (not in trash). Same invariant as
      //    RevisionsRepository.create — you can't comment on a deleted note.
      const note = this.db
        .prepare<[string], { id: string }>(
          'SELECT id FROM notes WHERE id = ? AND deleted_at IS NULL',
        )
        .get(noteId);
      if (!note) return;

      // 2. Parent validation: must exist on the same note + itself be
      //    top-level (parent_id IS NULL). Enforces the 1-level rule.
      if (parentId != null) {
        const parent = this.db
          .prepare<[string], { note_id: string; parent_id: string | null }>(
            'SELECT note_id, parent_id FROM note_comments WHERE id = ?',
          )
          .get(parentId);
        if (!parent || parent.note_id !== noteId) return; // treat as not-found
        if (parent.parent_id != null) {
          throw new NestedReplyError(parentId);
        }
      }

      // 3. Insert.
      const id = ulid();
      this.db
        .prepare(
          `INSERT INTO note_comments (id, note_id, parent_id, body, actor, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(id, noteId, parentId ?? null, body, actor, Date.now());
      createdId = id;
    });
    tx();

    return createdId ? this.getById(createdId) : null;
  }

  /** Single-row lookup. Used by route + tool gates (actor-match check). */
  getById(id: string): NoteComment | null {
    const row = this.db
      .prepare<[string], CommentRow>(
        `SELECT id, note_id, parent_id, body, actor, created_at, updated_at
         FROM note_comments WHERE id = ?`,
      )
      .get(id);
    return row ? this.rowToComment(row) : null;
  }

  /**
   * Paginated list for a single note, newest first.
   *
   * `before` is the `created_at` of the oldest item in the previous page. On
   * first page, pass `undefined` / omit. Tie-break on `id DESC` to keep same-ms
   * inserts deterministic (monotonic ulid keeps insertion order in the id).
   *
   * `limit` is clamped 1..200 by the caller (HTTP/MCP layer); the repo
   * doesn't second-guess — but a sanity max of 500 is applied here so a
   * buggy test can't ask for a million rows.
   */
  list(
    noteId: string,
    opts: { limit: number; before?: CommentCursor } = { limit: 20 },
  ): NoteCommentListPage {
    const limit = Math.max(1, Math.min(opts.limit, 500));

    // Fetch `limit + 1` rows so we can tell definitively whether another
    // page exists. If the DB returns exactly `limit + 1`, we slice the
    // extra off and emit a cursor; if fewer, no cursor. Avoids the "show
    // 'Load more' button that yields zero rows" UX bug that a naive
    // `returned < limit` check causes when the last page happens to fit
    // exactly.
    //
    // Compound cursor `(ts, id)` with tie-break on id handles bursty
    // writes in the same millisecond (chatty MCP agent + user post in
    // the same tick). Without the tie-break a single-ts cursor skips
    // rows or loops the same page forever.
    const overfetch = limit + 1;
    const rows =
      opts.before != null
        ? this.db
            .prepare<[string, number, number, string, number], CommentRow>(
              `SELECT id, note_id, parent_id, body, actor, created_at, updated_at
               FROM note_comments
               WHERE note_id = ?
                 AND (created_at < ? OR (created_at = ? AND id < ?))
               ORDER BY created_at DESC, id DESC
               LIMIT ?`,
            )
            .all(noteId, opts.before.ts, opts.before.ts, opts.before.id, overfetch)
        : this.db
            .prepare<[string, number], CommentRow>(
              `SELECT id, note_id, parent_id, body, actor, created_at, updated_at
               FROM note_comments
               WHERE note_id = ?
               ORDER BY created_at DESC, id DESC
               LIMIT ?`,
            )
            .all(noteId, overfetch);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map((r) => this.rowToComment(r));
    const last = items[items.length - 1];
    const nextCursor: CommentCursor | null =
      hasMore && last ? { ts: last.createdAt, id: last.id } : null;
    return { items, nextCursor };
  }

  /**
   * All replies under a given top-level comment. Ordered oldest-first
   * (chat-thread convention — newest reply at the bottom under its parent).
   * Usually called together with `list` to inline replies under their
   * parents for the UI, or from the activity union query to hydrate reply
   * bodies.
   */
  listByParent(parentId: string): NoteComment[] {
    const rows = this.db
      .prepare<[string], CommentRow>(
        `SELECT id, note_id, parent_id, body, actor, created_at, updated_at
         FROM note_comments
         WHERE parent_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(parentId);
    return rows.map((r) => this.rowToComment(r));
  }

  /**
   * Count of live comments on a note (includes replies). Used by the
   * kanban card badge and the activity endpoint's `X-Total-Count` header.
   * Cheap — covered by `idx_note_comments_note`.
   */
  count(noteId: string): number {
    const row = this.db
      .prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM note_comments WHERE note_id = ?')
      .get(noteId);
    return row?.c ?? 0;
  }

  /**
   * Batched count for kanban board render. Returns a Map of noteId → count
   * for the given ids. One indexed SELECT regardless of input length, same
   * N+1 avoidance pattern as `NotesRepository.tagsForNoteIds` (R6
   * 2026-04-17). Missing ids are absent from the map, not zero — caller
   * defaults via `?? 0`.
   */
  countForNotes(noteIds: readonly string[]): Map<string, number> {
    if (noteIds.length === 0) return new Map();
    const placeholders = noteIds.map(() => '?').join(',');
    const rows = this.db
      .prepare<string[], { note_id: string; c: number }>(
        `SELECT note_id, COUNT(*) AS c
         FROM note_comments
         WHERE note_id IN (${placeholders})
         GROUP BY note_id`,
      )
      .all(...noteIds);
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.note_id, r.c);
    return out;
  }

  /**
   * Edit a comment's body. Throws `CommentActorMismatchError` when the
   * caller's actor doesn't match the comment's own actor. Returns `null`
   * when the id doesn't exist (HTTP/MCP translates to 404).
   *
   * Sets `updated_at = now()`. No audit_log row — the comment itself with
   * its non-null `updated_at` is the evidence.
   */
  update(id: string, body: string, actor: string): NoteComment | null {
    const existing = this.getById(id);
    if (!existing) return null;
    if (existing.actor !== actor) {
      throw new CommentActorMismatchError(existing.actor, actor);
    }
    this.db
      .prepare('UPDATE note_comments SET body = ?, updated_at = ? WHERE id = ?')
      .run(body, Date.now(), id);
    return this.getById(id);
  }

  /**
   * Delete a comment. Cascades to replies via the FK. Throws
   * `CommentActorMismatchError` on wrong actor. Returns `true` when a row
   * was deleted, `false` when the id didn't exist.
   *
   * Does NOT write the `comment_delete` audit_log tombstone — that's the
   * caller's job (HTTP route / MCP tool), so the audit row carries the
   * correct `actor` from the request context even when repo-level helpers
   * call this internally (e.g. future bulk-delete flows).
   */
  delete(id: string, actor: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;
    if (existing.actor !== actor) {
      throw new CommentActorMismatchError(existing.actor, actor);
    }
    const res = this.db.prepare('DELETE FROM note_comments WHERE id = ?').run(id);
    return res.changes > 0;
  }

  private rowToComment(row: CommentRow): NoteComment {
    return {
      id: row.id,
      noteId: row.note_id,
      parentId: row.parent_id,
      body: row.body,
      actor: row.actor,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
