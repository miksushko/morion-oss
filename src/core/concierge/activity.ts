import type Database from 'better-sqlite3';
import type { NoteStatus } from '../notes/types.js';

/**
 * Direction V — Activity delta helpers.
 *
 * The engine reads these instead of scanning the whole workspace every
 * tick. Spec § "Use an event-ledger model, not 'read the whole workspace
 * every 5 minutes'".
 *
 * All helpers scope to a single folder — blast radius stays per-board
 * even if the Concierge misbehaves. Unfiled notes are deliberately
 * unreachable by the supervisor (folderId is required) so a global
 * opt-in isn't possible by accident.
 *
 * Implemented as free functions over `Database.Database` rather than
 * repo methods because the queries JOIN across audit_log, notes,
 * note_comments — cross-table reads that don't fit any single repo's
 * boundary. Repo methods stay single-table; these are view-style reads.
 */

export interface StatusTransitionEntry {
  noteId: string;
  actor: string;
  statusFrom: NoteStatus;
  statusTo: NoteStatus;
  ts: number;
}

export interface NewCommentEntry {
  noteId: string;
  commentId: string;
  actor: string;
  body: string;
  createdAt: number;
}

export interface NewNoteEntry {
  noteId: string;
  title: string;
  status: NoteStatus;
  createdAt: number;
  source: string;
}

export interface FolderActivityDelta {
  folderId: string;
  since: number;
  until: number;
  statusChanges: StatusTransitionEntry[];
  newComments: NewCommentEntry[];
  newNotes: NewNoteEntry[];
}

/**
 * Every "interesting" event in `folderId` between `since` and `until`.
 * Three independent cheap queries (cheaper than one big UNION ALL —
 * separate result sets let the engine prompt branch on them, and
 * SQLite plans each one against its own index). Soft-deleted notes
 * are filtered out so a trashed card doesn't appear as "activity".
 */
export function folderActivityDelta(
  db: Database.Database,
  folderId: string,
  since: number,
  until: number = Date.now(),
): FolderActivityDelta {
  const statusChanges = db
    .prepare<
      [string, number, number],
      {
        note_id: string;
        actor: string;
        status_from: NoteStatus;
        status_to: NoteStatus;
        ts: number;
      }
    >(
      `SELECT a.note_id, a.actor, a.status_from, a.status_to, a.ts
         FROM audit_log a
         JOIN notes n ON n.id = a.note_id
        WHERE n.folder_id = ?
          AND a.action = 'status_change'
          AND a.ts > ? AND a.ts <= ?
          AND n.deleted_at IS NULL
        ORDER BY a.ts ASC, a.id ASC`,
    )
    .all(folderId, since, until)
    .map((r) => ({
      noteId: r.note_id,
      actor: r.actor,
      statusFrom: r.status_from,
      statusTo: r.status_to,
      ts: r.ts,
    }));

  const newComments = db
    .prepare<
      [string, number, number],
      {
        id: string;
        note_id: string;
        actor: string;
        body: string;
        created_at: number;
      }
    >(
      `SELECT c.id, c.note_id, c.actor, c.body, c.created_at
         FROM note_comments c
         JOIN notes n ON n.id = c.note_id
        WHERE n.folder_id = ?
          AND c.created_at > ? AND c.created_at <= ?
          AND n.deleted_at IS NULL
        ORDER BY c.created_at ASC, c.id ASC`,
    )
    .all(folderId, since, until)
    .map((r) => ({
      noteId: r.note_id,
      commentId: r.id,
      actor: r.actor,
      body: r.body,
      createdAt: r.created_at,
    }));

  const newNotes = db
    .prepare<
      [string, number, number],
      {
        id: string;
        title: string;
        status: NoteStatus;
        created_at: number;
        source: string;
      }
    >(
      `SELECT id, title, status, created_at, source
         FROM notes
        WHERE folder_id = ?
          AND created_at > ? AND created_at <= ?
          AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC`,
    )
    .all(folderId, since, until)
    .map((r) => ({
      noteId: r.id,
      title: r.title,
      status: r.status,
      createdAt: r.created_at,
      source: r.source,
    }));

  return { folderId, since, until, statusChanges, newComments, newNotes };
}

export interface FolderTaskSummary {
  folderId: string;
  byStatus: Record<NoteStatus, number>;
  total: number;
}

/**
 * Count-per-status snapshot. Used by the engine prompt to show the
 * model the board shape without enumerating every card (the board can
 * be 200+ cards, stuffing each into context would blow the budget).
 */
export function folderTaskSummary(
  db: Database.Database,
  folderId: string,
): FolderTaskSummary {
  const rows = db
    .prepare<[string], { status: NoteStatus; n: number }>(
      `SELECT status, COUNT(*) AS n
         FROM notes
        WHERE folder_id = ? AND deleted_at IS NULL
        GROUP BY status`,
    )
    .all(folderId);
  const byStatus: Record<NoteStatus, number> = {
    note: 0,
    backlog: 0,
    todo: 0,
    doing: 0,
    review: 0,
    done: 0,
  };
  let total = 0;
  for (const r of rows) {
    byStatus[r.status] = r.n;
    total += r.n;
  }
  return { folderId, byStatus, total };
}

export interface AgentClaim {
  actor: string;
  claims: number;
  lastClaimAt: number;
}

/**
 * Distinct MCP actors who moved a card into `doing` within the window.
 * Helps the engine notice "claude-code has claimed 3 cards but hasn't
 * moved any to review" patterns. Only counts `status_change` with
 * `status_to='doing'` — actual claims, not passing transitions.
 */
export function agentClaims(
  db: Database.Database,
  folderId: string,
  since: number,
  until: number = Date.now(),
): AgentClaim[] {
  const rows = db
    .prepare<
      [string, number, number],
      { actor: string; claims: number; last_at: number }
    >(
      `SELECT a.actor, COUNT(*) AS claims, MAX(a.ts) AS last_at
         FROM audit_log a
         JOIN notes n ON n.id = a.note_id
        WHERE n.folder_id = ?
          AND a.action = 'status_change'
          AND a.status_to = 'doing'
          AND a.ts > ? AND a.ts <= ?
          AND n.deleted_at IS NULL
        GROUP BY a.actor
        ORDER BY claims DESC, last_at DESC`,
    )
    .all(folderId, since, until);
  return rows.map((r) => ({
    actor: r.actor,
    claims: r.claims,
    lastClaimAt: r.last_at,
  }));
}

export interface StaleTaskEntry {
  noteId: string;
  title: string;
  status: NoteStatus;
  updatedAt: number;
  /** Most recent audit_log.ts or note_comments.created_at — whichever
   * fires later. Treats BOTH as heartbeats. A card with a comment but
   * no status change in 3 hours is NOT stale; a card with silence in
   * both is. */
  lastHeartbeatAt: number;
  staleMs: number;
}

/**
 * Cards sitting in an active column past the stale threshold without
 * any heartbeat. Heartbeat = ANY activity: status change, comment,
 * body edit (which writes `audit_log action='update'` via autosave).
 * Applies only to `doing` + `review` by default — `note` and `done`
 * are supposed to sit, `backlog` is untouched work by definition,
 * `todo` is ready-but-unclaimed (Concierge might nudge an agent to
 * pick it up, but not as "stale").
 */
export function staleTasks(
  db: Database.Database,
  folderId: string,
  staleHours: number,
  statuses: NoteStatus[] = ['doing', 'review'],
  now: number = Date.now(),
): StaleTaskEntry[] {
  const cutoff = now - staleHours * 60 * 60 * 1000;
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(',');
  const rows = db
    .prepare<
      [string, ...string[]],
      {
        id: string;
        title: string;
        status: NoteStatus;
        updated_at: number;
        last_audit_ts: number | null;
        last_comment_ts: number | null;
      }
    >(
      `SELECT n.id, n.title, n.status, n.updated_at,
              (SELECT MAX(ts) FROM audit_log WHERE note_id = n.id) AS last_audit_ts,
              (SELECT MAX(created_at) FROM note_comments WHERE note_id = n.id) AS last_comment_ts
         FROM notes n
        WHERE n.folder_id = ?
          AND n.deleted_at IS NULL
          AND n.status IN (${placeholders})`,
    )
    .all(folderId, ...statuses);
  const result: StaleTaskEntry[] = [];
  for (const r of rows) {
    const heartbeat = Math.max(
      r.updated_at,
      r.last_audit_ts ?? 0,
      r.last_comment_ts ?? 0,
    );
    if (heartbeat >= cutoff) continue;
    result.push({
      noteId: r.id,
      title: r.title,
      status: r.status,
      updatedAt: r.updated_at,
      lastHeartbeatAt: heartbeat,
      staleMs: now - heartbeat,
    });
  }
  // Stalest first.
  result.sort((a, b) => b.staleMs - a.staleMs);
  return result;
}
