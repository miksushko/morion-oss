/**
 * Workflow orchestrator public types + constants.
 *
 * Extracted from src/core/auto-code/workflows/workflow-orchestrator.ts
 * on 2026-05-16. The barrel (workflow-orchestrator.ts) re-exports
 * EnqueueOutcome / WorkflowOrchestratorDeps / EnsureWorktreeArgs /
 * EnsureWorktreeFn / ResolvedWorkflow / WORKTREE_NAME_PREFIX /
 * MAX_INFLIGHT_PER_FOLDER for back-compat with the factory.
 */
import type Database from 'better-sqlite3';

import type { AuditLogger } from '../../../audit/log.js';
import type { ConciergeFolderSettingsRepository } from '../../../concierge/folder-settings-repository.js';
import type { ConciergeMessagesRepository } from '../../../concierge/messages-repository.js';
import type { ConciergeSessionsRepository } from '../../../concierge/sessions-repository.js';
import type { FoldersRepository } from '../../../folders/repository.js';
import type { NoteCommentsRepository } from '../../../notes/comments-repository.js';
import type { NotesRepository } from '../../../notes/repository.js';
import type { PreflightResult } from '../../preflight.js';
import type { MoMessengerDispatcher } from '../mo-messenger-dispatcher.js';
import type {
  RunHandle,
  WorkflowRunner,
} from '../runner.js';
import type { WorkflowRunsRepository } from '../runs-repository.js';
import type { WorkflowDefinition, WorkflowRunRow } from '../types/index.js';

export const WORKTREE_NAME_PREFIX = 'auto-';

/** Per-folder concurrency cap. Spec D17 — "хард-лимит = не более 5
 *  параллельных". The orchestrator refuses to enqueue when this many
 *  active workflow_runs already exist for the folder. */
export const MAX_INFLIGHT_PER_FOLDER = 5;

/** Shape returned by the `resolveDefinition` injection. Carries
 *  the parsed definition + the source row id (null for built-in
 *  templates) so downstream code can persist provenance. The
 *  orchestrator normalises legacy `(folderId) => WorkflowDefinition`
 *  callers transparently. */
export interface ResolvedWorkflow {
  definition: WorkflowDefinition;
  /** ULID from the `workflows` table when the user picked a
   *  custom workflow; null when the resolution path used a
   *  built-in registry template OR fell back to the default
   *  (e.g. stale id pointing at a deleted row). */
  workflowId: string | null;
}

export function normaliseResolved(
  raw: WorkflowDefinition | ResolvedWorkflow,
): ResolvedWorkflow {
  if ('definition' in raw && 'workflowId' in raw) return raw;
  return { definition: raw as WorkflowDefinition, workflowId: null };
}

export interface EnsureWorktreeArgs {
  repoPath: string;
  worktreeName: string;
  worktreePath: string;
}

export type EnsureWorktreeFn = (args: EnsureWorktreeArgs) => Promise<void>;

export interface WorkflowOrchestratorDeps {
  db: Database.Database;
  notes: NotesRepository;
  folders: FoldersRepository;
  comments: NoteCommentsRepository;
  audit: AuditLogger;
  folderSettings: ConciergeFolderSettingsRepository;
  /** Owned reference to the workflow_runs repository. Exposed
   *  separately from the runner (which uses the same repo
   *  internally) so the orchestrator can do read-side work
   *  (`findActiveRunForTicket`, `countActiveRunsInFolder`) without
   *  reaching into the runner's private deps. */
  runsRepo: WorkflowRunsRepository;
  runner: WorkflowRunner;
  /** Optional concierge sessions + messages repos. When set, an
   *  `escalated_by_review` terminal opens a real Ask Mo chat
   *  session (sidebar badge + needsHuman=true) carrying the
   *  reviewer's reason. When unset, escalation falls back to the
   *  comment-only path — minimum-viable signal stays intact for
   *  test deps that don't wire concierge. Mirrors the legacy
   *  AutoCodeOrchestrator's optional sessions/messages contract. */
  sessions?: ConciergeSessionsRepository;
  messages?: ConciergeMessagesRepository;

  /** How many recent comments to surface in the fix-stage prompt
   *  via `{{ticket.recentComments}}`. 5 mirrors the legacy
   *  orchestrator's context packager. */
  recentCommentsLimit?: number;

  /** Per-folder concurrency cap. Defaults to MAX_INFLIGHT_PER_FOLDER
   *  (3). When the cap is reached enqueueTicket returns
   *  `kind:'rejected', reason:'folder_cap_exceeded'`. */
  maxInflightPerFolder?: number;

  /** Resolve a workflow definition for a given folder. Default
   *  returns the hardcoded `DEFAULT_AUTOCODE_DEFINITION` with a
   *  null `workflowId` (built-in path). The factory in
   *  `auto-code-factory.ts` wires an impl that reads the per-folder
   *  workspace setting `auto_code.workflow_template.<folderId>` and
   *  looks the value up against the templates registry, then the
   *  `workflows` table.
   *
   *  Returns `workflowId` so the orchestrator can persist it onto
   *  `workflow_runs.workflow_id` — without it custom-workflow runs
   *  would lose their provenance link in the runs history (Codex
   *  P2a round 3, 2026-05-10). `null` for built-in templates;
   *  the row's ULID for `workflows` lookups. Tests inject
   *  arbitrary defs via the legacy single-arg shim
   *  (`(folderId) => def`); the orchestrator normalises both.
   *
   *  `taskId` is forwarded so the resolver can consult per-ticket
   *  overrides (`notes.workflow_id`) before falling back to the
   *  folder-level pinned setting (ticket
   *  01KRWQPDKQ2RZMDBJZ5KN0B7YE). Pass undefined to skip the per-
   *  ticket lookup (back-compat for tests using arbitrary defs). */
  resolveDefinition?: (
    folderId: string,
    taskId?: string,
  ) => WorkflowDefinition | ResolvedWorkflow;

  /** Probe whether a given agent (claude/codex/pi/opencode) is
   *  available on the host machine. Used to soft-reject enqueues
   *  where the resolved template's required agents include one
   *  that's not installed — fails BEFORE claiming a workflow_runs
   *  row + creating a worktree, so the user gets a clean
   *  `agent_unavailable` error instead of a late ENOENT inside
   *  adapter spawn. Default = always-true (back-compat for tests
   *  that don't care). */
  isAgentAvailable?: (agent: string) => boolean;

  /** Optional auto-merge hook fired right after the orchestrator
   *  marks a run `done` and posts the "✓ Auto-code done" comment.
   *  Used to honor the per-folder `auto_code.auto_merge.<folderId>`
   *  setting — when on, the implementation merges the worktree
   *  branch into trunk + posts a "✓ Merged into main" footprint
   *  without requiring the user to click "Merge into main" in the
   *  drawer. When off (or callback unset / no-op), the manual
   *  merge button remains the only path.
   *
   *  The callback decides whether to merge — orchestrator does NOT
   *  check the setting. This keeps the merge implementation +
   *  setting plumbing localized to the factory, avoiding a new
   *  `settings` dep on the orchestrator. Errors inside the callback
   *  must not throw — they're advisory; merge failures surface to
   *  the user via comments + activity feed. */
  autoMergeAfterDone?: (run: WorkflowRunRow) => Promise<void> | void;

  // Injection points for tests — defaults call the real impls.
  preflightImpl?: () => PreflightResult;
  worktreePathImpl?: (repoPath: string, worktreeName: string) => string;
  /** Create the per-run git worktree on disk before the runner spawns
   *  any adapter inside it. Default = `git worktree add <path> -b <branch>`
   *  (no-op when the path already exists, e.g. resume / dedupe path).
   *  The L1 adapter contract requires `cwd` to exist and be writable
   *  when adapter.spawn is called — without this step a fresh run
   *  failed with ENOENT inside child_process.spawn. */
  ensureWorktree?: EnsureWorktreeFn;
  /** Optional inverse of `ensureWorktree`. Called when we created a
   *  worktree but then discovered the run can't proceed (status
   *  changed mid-setup). Default = best-effort `git worktree remove
   *  --force <path>`. */
  cleanupWorktree?: (args: EnsureWorktreeArgs) => Promise<void>;
  /** Injectable for deterministic worktree names in tests. Default
   *  generates a fresh ULID. */
  generateWorktreeName?: () => string;
  /** Phase 6 V2 (Morion ticket 01KRG02E2SV2F9F3PZ6TPDDCNA) — Mo
   *  conversational composer. Replaces the verbatim agent-summary
   *  comment with a Mo-curated 1-2 sentence comment in `onStageEnd`
   *  for cli_agent / mcp_tool_call stages. Optional — when absent
   *  the verbatim post path stays as a fallback so users on a
   *  budget-exhausted workspace still see the agent output. */
  moMessenger?: MoMessengerDispatcher | null;
  now?: () => number;
}

export type EnqueueOutcome =
  | { kind: 'enqueued'; runId: string; deduped: boolean; handle: RunHandle }
  | {
      kind: 'rejected';
      reason: string;
      missingDetails?: readonly string[];
      blocking?: readonly string[];
    };
