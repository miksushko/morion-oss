import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type { Tier0Finding } from './mo-tier0.js';

/**
 * Mo Indexing Redesign Phase 5d — patrol-log finding lifecycle store.
 *
 * Side table on top of `mo:patrol-log` markdown note. Each Tier 0
 * finding inserted via `appendFindings` ALSO gets a row here with
 * `state='open'`; the user / agent flips state via the
 * `mo_acknowledge_finding` MCP tool.
 *
 * Snooze semantics: a row with `state='snoozed'` and `snooze_until`
 * in the past is treated as `'open'` on read (`listOpen` does the
 * implicit transition by query). No background flipper job needed.
 */

export type PatrolFindingState = 'open' | 'accepted' | 'dismissed' | 'snoozed';

export type PatrolFindingAction = 'accept' | 'dismiss' | 'snooze';

export interface PatrolFindingRecord {
  id: string;
  folderId: string;
  noteId: string | null;
  findingKind: string;
  severity: string;
  message: string;
  context: Record<string, unknown>;
  createdAt: number;
  state: PatrolFindingState;
  stateChangedAt: number;
  snoozeUntil: number | null;
}

interface Row {
  id: string;
  folder_id: string;
  note_id: string | null;
  finding_kind: string;
  severity: string;
  message: string;
  context: string;
  created_at: number;
  state: string;
  state_changed_at: number;
  snooze_until: number | null;
}

function rowTo(row: Row): PatrolFindingRecord {
  let context: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.context) as unknown;
    if (parsed && typeof parsed === 'object') {
      context = parsed as Record<string, unknown>;
    }
  } catch {
    context = {};
  }
  return {
    id: row.id,
    folderId: row.folder_id,
    noteId: row.note_id,
    findingKind: row.finding_kind,
    severity: row.severity,
    message: row.message,
    context,
    createdAt: row.created_at,
    state: row.state as PatrolFindingState,
    stateChangedAt: row.state_changed_at,
    snoozeUntil: row.snooze_until,
  };
}

export class MoPatrolFindingsRepository {
  constructor(private readonly db: Database.Database) {}

  /** Insert a batch of findings, all in state='open'. Returns the
   *  generated ids in the same order as the input. */
  insertBatch(
    folderId: string,
    findings: Tier0Finding[],
    now: number = Date.now(),
  ): string[] {
    if (findings.length === 0) return [];
    const stmt = this.db.prepare(
      `INSERT INTO mo_patrol_findings
         (id, folder_id, note_id, finding_kind, severity, message,
          context, created_at, state, state_changed_at, snooze_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)`,
    );
    const ids: string[] = [];
    const tx = this.db.transaction(() => {
      for (const f of findings) {
        const id = ulid();
        stmt.run(
          id,
          folderId,
          f.noteId,
          f.kind,
          f.severity,
          f.message,
          JSON.stringify(f.context ?? {}),
          now,
          now,
        );
        ids.push(id);
      }
    });
    tx();
    return ids;
  }

  get(id: string): PatrolFindingRecord | null {
    const row = this.db
      .prepare<[string], Row>(
        'SELECT * FROM mo_patrol_findings WHERE id = ?',
      )
      .get(id);
    return row ? rowTo(row) : null;
  }

  /**
   * Set lifecycle state. For `snooze`, supply `snoozeUntil` (ms-epoch);
   * for accept/dismiss, snoozeUntil is cleared.
   *
   * Returns `false` when the id doesn't exist; otherwise `true`.
   */
  setState(
    id: string,
    action: PatrolFindingAction,
    options: { snoozeUntil?: number; now?: number } = {},
  ): boolean {
    const now = options.now ?? Date.now();
    const newState: PatrolFindingState =
      action === 'accept'
        ? 'accepted'
        : action === 'dismiss'
          ? 'dismissed'
          : 'snoozed';
    const snoozeUntil =
      action === 'snooze' ? (options.snoozeUntil ?? null) : null;
    const result = this.db
      .prepare(
        `UPDATE mo_patrol_findings
            SET state = ?,
                state_changed_at = ?,
                snooze_until = ?
          WHERE id = ?`,
      )
      .run(newState, now, snoozeUntil, id);
    return result.changes > 0;
  }

  /**
   * List findings for a folder that the agent should consider. Returns
   *  rows with state='open' AND any state='snoozed' rows whose
   *  `snooze_until` is in the past (implicit re-open). Other states
   *  (accepted / dismissed / actively-snoozed) are skipped.
   */
  listOpen(folderId: string, now: number = Date.now()): PatrolFindingRecord[] {
    const rows = this.db
      .prepare<[string, number], Row>(
        `SELECT * FROM mo_patrol_findings
          WHERE folder_id = ?
            AND (state = 'open'
                 OR (state = 'snoozed' AND snooze_until IS NOT NULL AND snooze_until <= ?))
          ORDER BY created_at DESC`,
      )
      .all(folderId, now);
    return rows.map(rowTo);
  }

  /** Full history including accepted / dismissed — debug + UI feed. */
  listAll(folderId: string): PatrolFindingRecord[] {
    return this.db
      .prepare<[string], Row>(
        `SELECT * FROM mo_patrol_findings
          WHERE folder_id = ?
          ORDER BY created_at DESC`,
      )
      .all(folderId)
      .map(rowTo);
  }

  /** True iff this folder already has a non-dismissed finding for the
   *  same (note_id, finding_kind). Lets the next patrol pass dedup
   *  rather than re-inserting the same finding every minute. Returns
   *  false for a freshly-dismissed identical finding so the user's
   *  dismissal sticks across re-detections. */
  hasOpenSimilar(
    folderId: string,
    noteId: string | null,
    findingKind: string,
  ): boolean {
    const row = this.db
      .prepare<
        [string, string | null, string | null, string],
        { c: number }
      >(
        `SELECT COUNT(*) AS c FROM mo_patrol_findings
          WHERE folder_id = ?
            AND ((? IS NULL AND note_id IS NULL) OR note_id = ?)
            AND finding_kind = ?
            AND state IN ('open', 'snoozed', 'dismissed')`,
      )
      .get(folderId, noteId, noteId, findingKind);
    return (row?.c ?? 0) > 0;
  }
}
