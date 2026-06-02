import type Database from 'better-sqlite3';
import type { NoteCommentsRepository } from '../../../core/notes/comments-repository.js';
import type { SettingsRepository } from '../../../core/settings/repository.js';
import type { AutoCodeDispatcher } from '../auto-code-factory/index.js';

/**
 * Shared internals for the auto-code-tick split (Morion ticket
 * 01KRQYVA7GSM8W77J94JB2P615). Constants + types only — no behavior.
 * Re-exported from the `auto-code-tick.ts` barrel for back-compat.
 */

export const AUTO_CODE_AUDIT_CHECKPOINT_KEY = 'auto_code.audit_checkpoint';

/** Per-folder sweep marker. The PREVIOUS workspace-wide
 *  `auto_code.startup_sweep_done_at` was a P1 bug: enabling
 *  auto-code on a folder AFTER the first sweep silently lost
 *  every pre-existing `todo` ticket in that folder. Now each
 *  folder gets its own marker keyed by id; a freshly-enabled
 *  folder's marker is unset, so the next scheduler poll picks up
 *  its todos. */
export const AUTO_CODE_FOLDER_SWEEP_DONE_KEY_PREFIX =
  'auto_code.folder_sweep_done.';

/** Legacy workspace-wide marker. Read once on first run for
 *  back-compat with installs that landed it; never written. */
export const AUTO_CODE_STARTUP_SWEEP_DONE_KEY = 'auto_code.startup_sweep_done_at';

export function folderSweepKey(folderId: string): string {
  return `${AUTO_CODE_FOLDER_SWEEP_DONE_KEY_PREFIX}${folderId}`;
}

/** Maximum audit rows processed per tick. Bounds the worst-case
 *  effort of a single tick so a sudden burst of status changes
 *  doesn't block the scheduler for long. */
export const TICK_BATCH_LIMIT = 100;

/** Author actor for audit_log rows we should NOT echo back as
 *  enqueue triggers — these are state moves the auto-code engine
 *  itself makes (`mcp:auto-code` per `AUTO_CODE_ACTOR`). Echoing
 *  them would loop the engine onto its own kanban moves. */
export const AUTO_CODE_ACTOR_FILTER = 'mcp:auto-code';

export interface AutoCodeTickDeps {
  db: Database.Database;
  workspaceSettings: SettingsRepository;
  /** Dispatcher factory — one per tick to pick up the latest engine
   *  flag + configuration. The factory ALWAYS returns a usable
   *  dispatcher object (cancel/inflight surfaces work even when no
   *  enqueue engine is wired); enqueueTicket soft-rejects with
   *  `auto_code_unavailable` when no engine is available. */
  buildDispatcher: () => Promise<AutoCodeDispatcher>;
  /** Comments repo — used to post visible rejection comments on the
   *  ticket when the dispatcher rejects (workflow_not_runnable,
   *  agent_unavailable, etc.). Without this the rejection is silent
   *  from the user's POV — the ticket sits in `todo` forever with
   *  zero feedback. Optional for back-compat with tests; production
   *  start.ts MUST wire it. */
  comments?: NoteCommentsRepository;
  /** Optional structured logger; defaults to console.* mirror. */
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface EnqueueTickSummary {
  /** Number of audit_log rows inspected. */
  audited: number;
  /** Tickets the dispatcher accepted as `enqueued` (incl. dedupe). */
  enqueued: number;
  /** Tickets the dispatcher rejected (gates failed) — broken out by
   *  reason so the operator can spot persistent issues quickly. */
  rejected: Record<string, number>;
  /** New audit_log id checkpoint (max id of inspected rows). */
  newCheckpoint: number;
}

export interface AuditRow {
  id: number;
  note_id: string;
  folder_id: string;
}

export function defaultLog(): NonNullable<AutoCodeTickDeps['log']> {
  return {
    info: (m, meta) => console.log(`[auto-code-tick] ${m}`, meta ?? ''),
    warn: (m, meta) => console.warn(`[auto-code-tick] ${m}`, meta ?? ''),
  };
}
