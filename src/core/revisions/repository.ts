import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import type { NoteRevision, RevisionKind } from './types.js';

// Monotonic ulid: two ids minted in the same millisecond still sort in
// creation order. Critical here because the test suite (and real-world rapid
// MCP writes) can fire `create()` multiple times within a single tick, and
// the retention policy + listForNote both depend on a stable newest-first
// ordering. Used as a tie-breaker on created_at in the queries below.
const ulid = monotonicFactory();

interface RevisionRow {
  id: string;
  note_id: string;
  title: string;
  body: string;
  tags_json: string;
  folder_id: string | null;
  actor: string;
  created_at: number;
}

/**
 * Anything older than this is a `baseline` candidate. Picked at 4 hours so a
 * full work session normally produces only "recent" snapshots; the next-day
 * pickup gets a baseline that survives even if the user makes more than three
 * edits before realising they want to roll back.
 */
export const BASELINE_THRESHOLD_MS = 4 * 60 * 60 * 1000;

/** Maximum number of "recent" slots kept per note. */
export const MAX_RECENT_SLOTS = 3;

/**
 * Per-note version history with a 3-recent + 1-baseline retention policy.
 *
 * Capture model: callers (HTTP and MCP layers) call `create()` BEFORE the
 * mutation they're about to perform, so the snapshot represents the state the
 * user could roll back TO. The repository handles dedup, retention, and the
 * baseline computation; callers only pass the note id and the actor string.
 *
 * Why repository-level dedup: the UI can fire `create()` on every navigate-
 * away even when nothing actually changed (the navigate-away handler doesn't
 * know whether the note is dirty), and the MCP `notes_update` tool can be
 * called with a no-op patch. Repository checks the latest revision against
 * current note state and skips the insert if they match byte-for-byte —
 * including tag id set and folder id, not just title and body.
 */
export class RevisionsRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Snapshot a note's current state. Returns the new revision, the existing
   * latest revision (if it was identical and we deduped), or `null` if the
   * note id doesn't exist or is hard-deleted.
   *
   * The whole operation runs inside a single transaction so a concurrent
   * mutation can't slip between the snapshot read and the retention prune.
   * `getById` after `tx()` re-reads the row outside the tx, which is fine —
   * the new row is committed by then.
   */
  create(noteId: string, actor: string): NoteRevision | null {
    let createdId: string | null = null;
    let dedupedId: string | null = null;

    const tx = this.db.transaction(() => {
      // 1. Read current note state. We need the live (non-soft-deleted)
      //    version because soft-deleted notes are still "in the trash" and
      //    callers shouldn't be snapshotting them — the UI can't edit a
      //    trashed note, and MCP tools refuse to operate on them.
      const noteRow = this.db
        .prepare<[string], { title: string; body: string; folder_id: string | null }>(
          'SELECT title, body, folder_id FROM notes WHERE id = ? AND deleted_at IS NULL',
        )
        .get(noteId);
      if (!noteRow) return;

      const tagIds = this.db
        .prepare<[string], { tag_id: string }>(
          'SELECT tag_id FROM note_tags WHERE note_id = ? ORDER BY tag_id',
        )
        .all(noteId)
        .map((r) => r.tag_id);
      const tagsJson = JSON.stringify(tagIds);

      // 2. Dedup against the most recent revision. Comparing the
      //    serialised tag id list works because we sorted by tag_id
      //    above — the JSON is canonical for a given set.
      //
      //    Bodies are compared after `normalizeForDedup` to absorb
      //    cosmetic churn that doesn't reflect a real edit: CRLF vs
      //    LF (Windows clipboard paste), trailing-space-before-\n
      //    (some editors strip, some don't), trailing newlines at
      //    end of file. Without normalisation a keystroke-autosave
      //    right after paste would burn a revision slot on what's
      //    semantically the same content, evicting a real earlier
      //    snapshot from the 3-recent + 1-baseline retention policy.
      //    Audit N20, 2026-04-16.
      const latest = this.db
        .prepare<[string], RevisionRow>(
          `SELECT id, note_id, title, body, tags_json, folder_id, actor, created_at
           FROM note_revisions
           WHERE note_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT 1`,
        )
        .get(noteId);
      if (
        latest &&
        latest.title === noteRow.title &&
        normalizeForDedup(latest.body) === normalizeForDedup(noteRow.body) &&
        latest.tags_json === tagsJson &&
        latest.folder_id === noteRow.folder_id
      ) {
        dedupedId = latest.id;
        return;
      }

      // 3. Insert the new snapshot.
      const id = ulid();
      this.db
        .prepare(
          `INSERT INTO note_revisions
             (id, note_id, title, body, tags_json, folder_id, actor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, noteId, noteRow.title, noteRow.body, tagsJson, noteRow.folder_id, actor, Date.now());
      createdId = id;

      // 4. Prune to retention policy. See `computeKeepSet` for the rules.
      this.pruneRetention(noteId);
    });
    tx();

    const winningId = createdId ?? dedupedId;
    return winningId ? this.getById(winningId) : null;
  }

  /**
   * All surviving revisions for a note, newest first, with `kind` computed
   * against `now` so the caller doesn't need a second query. Up to four rows
   * — three `recent` and at most one `baseline`. Returns an empty array if
   * the note has no history yet.
   */
  listForNote(noteId: string, now: number = Date.now()): NoteRevision[] {
    const rows = this.db
      .prepare<[string], RevisionRow>(
        `SELECT id, note_id, title, body, tags_json, folder_id, actor, created_at
         FROM note_revisions
         WHERE note_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(noteId);
    return rows.map((r) => this.rowToRevision(r, this.kindFor(r.created_at, now)));
  }

  /** Single revision lookup, used by the restore endpoint. */
  getById(id: string, now: number = Date.now()): NoteRevision | null {
    const row = this.db
      .prepare<[string], RevisionRow>(
        `SELECT id, note_id, title, body, tags_json, folder_id, actor, created_at
         FROM note_revisions
         WHERE id = ?`,
      )
      .get(id);
    if (!row) return null;
    return this.rowToRevision(row, this.kindFor(row.created_at, now));
  }

  /**
   * Retention policy: keep the three newest revisions (the "recent" slots)
   * plus the newest revision that is at least 4h old AND not already in the
   * recent set (the "baseline" slot). Delete everything else.
   *
   * Edge cases:
   * - Fewer than 3 revisions → nothing to prune.
   * - All revisions younger than 4h → no baseline, just keep the newest 3.
   * - All revisions older than 4h → newest 3 are recents, the 4th-newest is
   *   the baseline. Anything older than that is dropped.
   *
   * Runs inside the same transaction as the parent insert so a concurrent
   * snapshot can't sneak in and inflate the row count past four.
   */
  private pruneRetention(noteId: string): void {
    const rows = this.db
      .prepare<[string], { id: string; created_at: number }>(
        `SELECT id, created_at FROM note_revisions
         WHERE note_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(noteId);
    if (rows.length <= MAX_RECENT_SLOTS) return;

    const now = Date.now();
    const keep = new Set<string>();

    // Recent slots: newest N regardless of age.
    for (let i = 0; i < Math.min(MAX_RECENT_SLOTS, rows.length); i++) {
      keep.add(rows[i]!.id);
    }

    // Baseline slot: newest revision aged past the threshold that isn't
    // already a recent. There can only ever be one.
    for (const row of rows) {
      if (keep.has(row.id)) continue;
      if (now - row.created_at >= BASELINE_THRESHOLD_MS) {
        keep.add(row.id);
        break;
      }
    }

    const toDelete = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
    if (toDelete.length === 0) return;
    const stmt = this.db.prepare('DELETE FROM note_revisions WHERE id = ?');
    for (const id of toDelete) stmt.run(id);
  }

  private kindFor(createdAt: number, now: number): RevisionKind {
    return now - createdAt >= BASELINE_THRESHOLD_MS ? 'baseline' : 'recent';
  }

  private rowToRevision(row: RevisionRow, kind: RevisionKind): NoteRevision {
    let tagIds: string[] = [];
    try {
      const parsed = JSON.parse(row.tags_json);
      if (Array.isArray(parsed)) tagIds = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      // tags_json is repository-controlled, but a corrupt blob shouldn't
      // crash the whole revisions list — fall back to "no tags".
      tagIds = [];
    }
    return {
      id: row.id,
      noteId: row.note_id,
      title: row.title,
      body: row.body,
      tagIds,
      folderId: row.folder_id,
      actor: row.actor,
      createdAt: row.created_at,
      kind,
    };
  }
}

/**
 * Normalise a note body for revision dedup comparison. Cosmetic
 * differences that don't reflect a real content edit are squashed:
 *   - CRLF → LF (pasted from Windows clipboard)
 *   - trailing-space-before-\n → \n (some editors strip, some don't)
 *   - trailing \n at end of file → none (editor choice)
 *
 * Output is NOT used as the stored body — the original bytes are
 * persisted untouched. This function only exists to answer the
 * question "is this effectively the same content as the last
 * snapshot?" so a string round-trip through an editor doesn't burn
 * a slot in the 4-entry retention. Audit N20, 2026-04-16.
 */
function normalizeForDedup(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n+$/, '');
}
