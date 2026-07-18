import type Database from 'better-sqlite3';
import type { NoteStatus } from '../notes/types.js';

// Direction N adds 'status_change' alongside the five core actions. Rows
// with action='status_change' carry `status_from` and `status_to`; rows
// with any other action leave those columns NULL.
//
// Direction Q adds 'comment_delete' — tombstone for a deleted note_comment
// row. Comment create/update are evidenced by the row itself (updated_at
// is non-null on edit), so only delete gets an audit row. Same shape as
// other single-note actions; status_from/to remain NULL.
//
// The Mo Workflows epic adds the workflow_*
// actions for MCP mutations of Auto-code workflow definitions. On those
// rows `note_id` carries the `workflows.id` ULID (the column is a plain
// TEXT with no FK — it acts as a generic subject id here; the
// `audit_recent` LEFT JOIN on notes simply yields a null title).
export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'read'
  | 'status_change'
  | 'comment_delete'
  | 'archive'
  | 'unarchive'
  | 'workflow_create'
  | 'workflow_update'
  | 'workflow_delete';

export interface AuditEntry {
  noteId: string | null;
  action: AuditAction;
  actor: string;
}

export type WorkflowAuditAction =
  | 'workflow_create'
  | 'workflow_update'
  | 'workflow_delete';

export interface WorkflowAuditEntry {
  workflowId: string;
  action: WorkflowAuditAction;
  actor: string;
}

export interface StatusChangeEntry {
  noteId: string;
  actor: string;
  statusFrom: NoteStatus;
  statusTo: NoteStatus;
}

/**
 * One row of the audit log enriched with the current note title (joined via
 * LEFT JOIN). Used by the `audit_recent` MCP tool. Soft-deleted notes are
 * NOT filtered out — an audit log that hides what was deleted is useless,
 * so the LEFT JOIN ignores `deleted_at`.
 */
export interface AuditRecentEntry {
  id: number;
  noteId: string | null;
  noteTitle: string | null;
  action: AuditAction;
  actor: string;
  timestamp: number;
  /** Direction N — populated only for `status_change` rows. */
  statusFrom: NoteStatus | null;
  statusTo: NoteStatus | null;
}

/**
 * Direction N — single row of a note's kanban history, read by
 * `tasks_history(noteId)`. Always a status_change, so status_from/to are
 * non-null (the DB schema allows NULL for other actions; this type narrows).
 */
export interface StatusHistoryEntry {
  id: number;
  noteId: string;
  actor: string;
  timestamp: number;
  statusFrom: NoteStatus;
  statusTo: NoteStatus;
}

/**
 * Update-audit coalesce window. Consecutive `update` rows by the same
 * actor on the same note within this window collapse into a single row
 * with the latest ts. Rationale: autosave fires a PATCH per debounce
 * (500ms), which would otherwise burn one audit row per keystroke —
 * hundreds per minute on a typing session. Coalescing trims this to
 * ~one row per editing session without losing the forensic "user
 * edited this note" record.
 *
 * 5 minutes matches the idle-revision threshold in
 * `RevisionsRepository` so the two lifecycles tell the same story at
 * comparable granularity.
 *
 * Implementation: on `update`, if the LATEST audit row for the note is
 * `action='update'` by the same actor within the window, DELETE it +
 * INSERT a fresh row. DELETE+INSERT (rather than UPDATE ts in place)
 * keeps `id DESC` ordering consistent with `ts DESC`, which matters
 * for `audit_recent` and `tasks_history` callers that sort by id.
 *
 * Only `action='update'` coalesces. `create` / `delete` / `read` /
 * `status_change` / `comment_delete` are discrete events by design.
 */
const UPDATE_COALESCE_WINDOW_MS = 5 * 60 * 1000;

export class AuditLogger {
  private readonly insertStmt: Database.Statement;
  private readonly insertStatusChangeStmt: Database.Statement;
  private readonly latestRowStmt: Database.Statement;
  private readonly deleteByIdStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(
      'INSERT INTO audit_log (note_id, action, actor, ts) VALUES (?, ?, ?, ?)',
    );
    this.insertStatusChangeStmt = db.prepare(
      `INSERT INTO audit_log (note_id, action, actor, ts, status_from, status_to)
       VALUES (?, 'status_change', ?, ?, ?, ?)`,
    );
    // Latest row for a given note_id. Used by the update-coalesce path.
    this.latestRowStmt = db.prepare<
      [string],
      { id: number; action: string; actor: string; ts: number }
    >(
      `SELECT id, action, actor, ts
       FROM audit_log
       WHERE note_id = ?
       ORDER BY id DESC
       LIMIT 1`,
    );
    this.deleteByIdStmt = db.prepare('DELETE FROM audit_log WHERE id = ?');
  }

  record(entry: AuditEntry): void {
    const now = Date.now();

    // Coalesce `update` rows for the same note+actor within the
    // window. See UPDATE_COALESCE_WINDOW_MS for rationale.
    if (entry.action === 'update' && entry.noteId) {
      const latest = this.latestRowStmt.get(entry.noteId) as
        | { id: number; action: string; actor: string; ts: number }
        | undefined;
      if (
        latest &&
        latest.action === 'update' &&
        latest.actor === entry.actor &&
        now - latest.ts <= UPDATE_COALESCE_WINDOW_MS
      ) {
        // Run inside a tx so a concurrent reader can't see the gap
        // between delete and insert.
        this.db.transaction(() => {
          this.deleteByIdStmt.run(latest.id);
          this.insertStmt.run(entry.noteId, entry.action, entry.actor, now);
        })();
        return;
      }
    }

    this.insertStmt.run(entry.noteId, entry.action, entry.actor, now);
  }

  /**
   * Mo Workflows — record an MCP mutation of an Auto-code workflow
   * definition. Dedicated entry point so callers can't accidentally
   * mix workflow ids into note-action rows: the workflow ULID lands in
   * `note_id` (generic subject id on workflow_* rows), the action is
   * one of the workflow_* variants, and none of the update-coalescing
   * applies (workflow edits are discrete events).
   */
  recordWorkflow(entry: WorkflowAuditEntry): void {
    this.insertStmt.run(entry.workflowId, entry.action, entry.actor, Date.now());
  }

  /**
   * Direction N — record a kanban status transition. Dedicated entry point
   * because `status_from` / `status_to` are typed columns (not JSON) and
   * shouldn't leak into generic `record()` callers.
   */
  recordStatusChange(entry: StatusChangeEntry): void {
    this.insertStatusChangeStmt.run(
      entry.noteId,
      entry.actor,
      Date.now(),
      entry.statusFrom,
      entry.statusTo,
    );
  }

  /**
   * Last `limit` rows from `audit_log`, joined with `notes.title` so the
   * caller doesn't need a second query. Optional `actor` filter narrows to a
   * single MCP client (`mcp:claude-ai`, `mcp:cursor`, ...).
   */
  recent(limit: number, actor?: string): AuditRecentEntry[] {
    const where = actor ? 'WHERE a.actor = ?' : '';
    const sql = `SELECT a.id, a.note_id, a.action, a.actor, a.ts,
                        a.status_from, a.status_to,
                        n.title AS note_title
                 FROM audit_log a
                 LEFT JOIN notes n ON n.id = a.note_id
                 ${where}
                 ORDER BY a.id DESC
                 LIMIT ?`;
    const rows = (
      actor
        ? this.db.prepare(sql).all(actor, limit)
        : this.db.prepare(sql).all(limit)
    ) as Array<{
      id: number;
      note_id: string | null;
      action: string;
      actor: string;
      ts: number;
      status_from: string | null;
      status_to: string | null;
      note_title: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      noteId: r.note_id,
      noteTitle: r.note_title,
      action: r.action as AuditAction,
      actor: r.actor,
      timestamp: r.ts,
      statusFrom: r.status_from as NoteStatus | null,
      statusTo: r.status_to as NoteStatus | null,
    }));
  }

  /**
   * Direction N — chronological `status_change` history for a single note,
   * powering the `tasks_history(noteId)` MCP tool. Newest first, capped
   * by `limit`.
   */
  statusHistory(noteId: string, limit: number): StatusHistoryEntry[] {
    const rows = this.db
      .prepare<[string, number], {
        id: number;
        actor: string;
        ts: number;
        status_from: string | null;
        status_to: string | null;
      }>(
        `SELECT id, actor, ts, status_from, status_to
         FROM audit_log
         WHERE note_id = ? AND action = 'status_change'
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(noteId, limit);
    return rows
      // Paranoid filter: a future migration might let status_from/to be
      // nullable on status_change rows; we never want to emit such rows
      // from this API because the caller's type says non-null.
      .filter((r) => r.status_from !== null && r.status_to !== null)
      .map((r) => ({
        id: r.id,
        noteId,
        actor: r.actor,
        timestamp: r.ts,
        statusFrom: r.status_from as NoteStatus,
        statusTo: r.status_to as NoteStatus,
      }));
  }
}
