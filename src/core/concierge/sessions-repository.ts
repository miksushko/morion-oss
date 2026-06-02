import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import type { ConciergeSession, ConciergeSessionOpenedBy } from './types.js';

// Monotonic so two session.open calls in the same ms stay ordered —
// matches the comments/revisions pattern.
const ulid = monotonicFactory();

interface Row {
  id: string;
  folder_id: string | null;
  title: string;
  opened_by: ConciergeSessionOpenedBy;
  needs_human: number;
  archived_at: number | null;
  /** Phase 5 (migration 0032) — link from this chat to a paused
   *  workflow_runs row. NULL on all non-workflow sessions. */
  workflow_run_id: string | null;
  created_at: number;
  updated_at: number;
}

function rowToSession(row: Row): ConciergeSession {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    openedBy: row.opened_by,
    needsHuman: row.needs_human === 1,
    archivedAt: row.archived_at,
    workflowRunId: row.workflow_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateSessionInput {
  folderId?: string | null;
  title?: string;
  openedBy: ConciergeSessionOpenedBy;
  needsHuman?: boolean;
  /** Phase 5 — when this session is being created to ask the user a
   *  workflow `human_gate` question, pass the run id so the chat
   *  route's resume hook can find it. Default null. */
  workflowRunId?: string | null;
}

/**
 * Direction V — Concierge chat sessions.
 *
 * Shape mirrors ChatGPT/Claude conversation lists. Messages live in
 * a sibling table (`ConciergeMessagesRepository`) with a cascading FK
 * so deleting a session reaps its transcript. `archivedAt` hides a
 * session from the default list without destroying it — matches the
 * notes-archive pattern from Direction S.
 */
export class ConciergeSessionsRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateSessionInput, now: number = Date.now()): ConciergeSession {
    const id = ulid(now);
    const row: Row = {
      id,
      folder_id: input.folderId ?? null,
      title: input.title ?? '',
      opened_by: input.openedBy,
      needs_human: input.needsHuman ? 1 : 0,
      archived_at: null,
      workflow_run_id: input.workflowRunId ?? null,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO concierge_sessions (
           id, folder_id, title, opened_by, needs_human,
           archived_at, workflow_run_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.folder_id,
        row.title,
        row.opened_by,
        row.needs_human,
        row.archived_at,
        row.workflow_run_id,
        row.created_at,
        row.updated_at,
      );
    return rowToSession(row);
  }

  /** Phase 5 — fast lookup of the session linked to a paused workflow
   *  run. Used by the runner's resume path to find the message thread
   *  + by the cancel path to mark the abandoned chat as no-longer-
   *  needing-a-human. */
  findByWorkflowRunId(runId: string): ConciergeSession | null {
    const row = this.db
      .prepare<[string], Row>(
        'SELECT * FROM concierge_sessions WHERE workflow_run_id = ? LIMIT 1',
      )
      .get(runId);
    return row ? rowToSession(row) : null;
  }

  get(id: string): ConciergeSession | null {
    const row = this.db
      .prepare<[string], Row>('SELECT * FROM concierge_sessions WHERE id = ?')
      .get(id);
    return row ? rowToSession(row) : null;
  }

  /** Active sessions (archivedAt IS NULL) ordered newest-first. */
  list(opts: { limit?: number; includeArchived?: boolean } = {}): ConciergeSession[] {
    const limit = Math.min(opts.limit ?? 100, 500);
    // Tie-break by id DESC so two sessions created in the same ms stay
    // deterministically ordered. ulid is monotonic, so newer id > older
    // id within the same ms, and id DESC matches created/updated order.
    const sql = opts.includeArchived
      ? 'SELECT * FROM concierge_sessions ORDER BY updated_at DESC, id DESC LIMIT ?'
      : 'SELECT * FROM concierge_sessions WHERE archived_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?';
    const rows = this.db.prepare<[number], Row>(sql).all(limit);
    return rows.map(rowToSession);
  }

  /** Count of sessions awaiting a human reply — drives the Sidebar
   * tab badge. */
  countNeedsHuman(): number {
    const row = this.db
      .prepare<[], { n: number }>(
        'SELECT COUNT(*) AS n FROM concierge_sessions WHERE needs_human = 1 AND archived_at IS NULL',
      )
      .get();
    return row?.n ?? 0;
  }

  rename(id: string, title: string, now: number = Date.now()): ConciergeSession | null {
    this.db
      .prepare(
        'UPDATE concierge_sessions SET title = ?, updated_at = ? WHERE id = ?',
      )
      .run(title, now, id);
    return this.get(id);
  }

  /** Flip `needs_human`. Called by the engine when a new question is
   * posted (→ true) and by the HTTP layer when a user replies (→ false). */
  setNeedsHuman(id: string, needsHuman: boolean, now: number = Date.now()): void {
    this.db
      .prepare(
        'UPDATE concierge_sessions SET needs_human = ?, updated_at = ? WHERE id = ?',
      )
      .run(needsHuman ? 1 : 0, now, id);
  }

  /** Bump `updated_at` — called by the messages repo on every message
   * insert so the sidebar ordering reflects chat freshness. */
  touch(id: string, now: number = Date.now()): void {
    this.db
      .prepare('UPDATE concierge_sessions SET updated_at = ? WHERE id = ?')
      .run(now, id);
  }

  archive(id: string, now: number = Date.now()): void {
    this.db
      .prepare(
        'UPDATE concierge_sessions SET archived_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(now, now, id);
  }

  unarchive(id: string, now: number = Date.now()): void {
    this.db
      .prepare(
        'UPDATE concierge_sessions SET archived_at = NULL, updated_at = ? WHERE id = ?',
      )
      .run(now, id);
  }

  delete(id: string): void {
    // Messages cascade via FK.
    this.db.prepare('DELETE FROM concierge_sessions WHERE id = ?').run(id);
  }
}
