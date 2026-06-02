/**
 * Workflow orchestrator — admission control (enqueueTicket).
 *
 * Extracted from src/core/auto-code/workflows/workflow-orchestrator.ts
 * on 2026-05-16. Takes the orchestrator instance as its first arg
 * so it can read deps + tuning knobs without becoming a class method —
 * see workflow-orchestrator.ts header for the pattern.
 */
import { LinearWorkflowError, parseRunnableWorkflow } from '../parse-linear.js';
import type { TicketContext } from '../runner.js';
import type { WorkflowDefinition } from '../types/index.js';
import type { WorkflowOrchestrator as WO } from '../workflow-orchestrator.js';
import { buildHooks } from './hooks.js';
import { collectRequiredAgents } from './helpers.js';
import type { EnqueueOutcome } from './types.js';
import { buildRecentCommentsBlock, makeAttachedHandle } from './escalation.js';

export async function enqueueTicket(orch: WO, taskId: string, folderId: string): Promise<EnqueueOutcome> {
  const folder = orch.deps.folders.getById(folderId);
  if (!folder) {
    throw new Error(`enqueueTicket: folder ${folderId} not found`);
  }
  const task = orch.deps.notes.getById(taskId);
  if (!task) {
    throw new Error(`enqueueTicket: task ${taskId} not found`);
  }
  const settings = orch.deps.folderSettings.getOrDefault(folderId);

  if (!settings.autoCodeEnabled) {
    return { kind: 'rejected', reason: 'auto_code_disabled' };
  }
  if (!settings.enabled) {
    // Mo is the orchestration backbone (per umbrella spec) — without
    // Mo enabled, auto-code can't proceed. The HTTP route ALSO
    // gates this on toggle, but we double-check defensively.
    return { kind: 'rejected', reason: 'mo_disabled' };
  }
  if (!settings.linkedRepoPath) {
    return { kind: 'rejected', reason: 'linked_repo_missing' };
  }

  // Pre-runner dedupe runs FIRST — before the stale-enqueue gate.
  // An active run already moved the card to `doing` / `review` via
  // its `onRunStart` / `onStageEnd` hooks, so the ticket's status
  // is no longer `todo` even though it WAS at trigger time. Skip
  // the stale check on the dedupe path; the runner's partial
  // unique index already proved the existing run is in flight.
  const existingActive = orch.deps.runsRepo.findActiveRunForTicket(folderId, taskId);
  if (existingActive) {
    const handle = makeAttachedHandle(orch, existingActive.id);
    return {
      kind: 'enqueued',
      runId: existingActive.id,
      deduped: true,
      handle,
    };
  }

  // Stale-enqueue gate. The kanban route fires enqueue
  // fire-and-forget — between the user's drag-to-`todo` and our
  // arrival here (preflight ~5s), the user can
  // drag the card OUT of `todo` (to backlog / done / doing). When
  // that happened we MUST NOT start a run; doing so would override
  // the user's later state move (onRunStart's todo→doing kanban
  // call would race with whatever they actually wanted).
  if (task.status !== 'todo') {
    return {
      kind: 'rejected',
      reason: 'ticket_no_longer_todo',
      missingDetails: [`current status: ${task.status}`],
    };
  }

  // Per-folder concurrency cap. Mirrors the legacy
  // MAX_INFLIGHT_PER_FOLDER gate in queue.ts. Now that the
  // pre-runner dedupe ran, this cap measures DISTINCT active
  // tickets only — a re-enqueue against the same ticket already
  // returned via the deduped path above.
  const inflight = orch.deps.runsRepo.countActiveRunsInFolder(folderId);
  if (inflight >= orch.maxInflightPerFolder) {
    return {
      kind: 'rejected',
      reason: 'folder_cap_exceeded',
      missingDetails: [
        `folder already has ${inflight} active runs (cap ${orch.maxInflightPerFolder})`,
      ],
    };
  }

  // Preflight: claude binary present, MCP wired into Claude config.
  const pf = orch.preflightImpl();
  if (pf.blocking.length > 0) {
    return {
      kind: 'rejected',
      reason: 'preflight_blocked',
      blocking: pf.blocking,
    };
  }

  // ── Actionability gate REMOVED on the new path ────────────────
  // The legacy orchestrator gates every enqueue with a single
  // Claude Haiku "is this ticket detailed enough" check. We're
  // not running it here:
  //
  //   1. Architecturally it's a pre-flight TASK that belongs as a
  //      configurable workflow stage (cli_agent[claude] with a
  //      custom prompt) in the L4 editor, not as a hardcoded gate
  //      in the orchestrator. Users will be able to add / remove /
  //      reorder it like any other stage.
  //   2. Pragmatically it added a 5-10s round trip + $0.001-0.005
  //      to every drag-to-todo, blocked dogfood when claude was
  //      slow / down, and false-rejected real tickets that just
  //      had short bodies.
  //
  // A future "Mo review with custom instructions" stage at the
  // start of the Default Autocode template restores the same
  // behaviour without the global gate. Tracked under L4 editor
  // tickets. (The legacy `evaluate(...)` helper still lives in
  // `../actionability.js` for the legacy AutoCodeOrchestrator;
  // the workflow path no longer imports it.)

  // Build the ticket context surfaced to prompt templates as
  // `{{ticket.*}}`. recentComments is a flat newline-joined block
  // — the template owns formatting (cross-layer invariant: typed
  // primitives, no runtime expression language).
  const ticketContext: TicketContext = {
    id: task.id,
    title: task.title,
    body: task.body ?? '',
    recentComments: buildRecentCommentsBlock(orch, taskId),
  };

  // Compute a fresh worktree path. Snapshotted on the workflow_run
  // row so post-restart recovery (T6) and worktree cleanup don't
  // re-derive from possibly-mutated folder settings.
  const worktreeName = orch.generateWorktreeName();
  const worktreePath = orch.worktreePathImpl(settings.linkedRepoPath, worktreeName);

  // Atomic admission. Claim the workflow_runs row BEFORE
  // ensureWorktree / runner dispatch so concurrent enqueues
  // collapse via the partial unique index `idx_workflow_runs_active_unique`.
  // Without this claim two parallel triggers could both pass the
  // pre-runner dedupe lookup, both run `git worktree add` (creating
  // a stray worktree on the loser), and only afterwards collide
  // inside runner.start. Now the loser short-circuits IMMEDIATELY
  // with `deduped: true` and never touches the filesystem.
  // Per-folder template selection. The resolver reads
  // `auto_code.workflow_template.<folderId>` from workspace settings
  // (factory-wired) and falls back to DEFAULT_AUTOCODE_DEFINITION on
  // missing / unknown ids. Re-validate via parseLinearWorkflow as
  // defence-in-depth — the registry already parses at module load,
  // but tests inject raw defs and a future "user-edited workflow"
  // path will too.
  const resolved = orch.resolveDefinitionFn(folderId, taskId);
  // The folder's active workflow may be a v2 draft (mo_stage /
  // reject_sink / complete_sink / mo_router / eject) — the editor
  // saves those via `parseDraftWorkflow` ahead of the Phase 4 DAG
  // runner shipping. The linear runner can't dispatch them, so
  // catch the LinearWorkflowError here and return a clean
  // `workflow_not_runnable` rejection instead of a 500. The user
  // gets actionable feedback ("this workflow uses v2 stage kinds
  // that need the DAG runner — switch the folder's template to a
  // linear one") instead of an opaque server crash.
  let linearDef: WorkflowDefinition;
  try {
    linearDef = parseRunnableWorkflow(resolved.definition);
  } catch (err) {
    if (err instanceof LinearWorkflowError) {
      return {
        kind: 'rejected',
        reason: 'workflow_not_runnable',
        missingDetails: [
          `Workflow "${resolved.definition?.name ?? '<unnamed>'}" contains a stage kind not yet supported by the runner. Edit the workflow to remove the unsupported stage, or wait for the next phase to ship.`,
          err.message,
        ],
      };
    }
    throw err;
  }

  // Required-agents preflight (Codex P2, 2026-05-10). Without this
  // check a folder selecting `pi-fix` while pi isn't installed
  // would claim a workflow_runs row + create a worktree, then
  // crash inside adapter.spawn with `AgentBinaryNotFoundError`.
  // Surface the same signal as a clean rejection BEFORE the row is
  // created, mirroring the legacy preflight contract.
  const missingAgents = collectRequiredAgents(linearDef).filter(
    (a) => !orch.isAgentAvailableFn(a),
  );
  if (missingAgents.length > 0) {
    return {
      kind: 'rejected',
      reason: 'agent_unavailable',
      missingDetails: [
        `Workflow "${linearDef.name}" requires ${missingAgents.join(', ')} but ${
          missingAgents.length === 1 ? "it's" : "they're"
        } not installed on this machine. Switch the folder's workflow template or install the missing agent.`,
      ],
    };
  }
  const claim = orch.deps.runsRepo.createRun({
    folderId,
    ticketId: taskId,
    // Provenance link: when the resolver picked a custom workflow
    // row, persist its ULID on `workflow_runs.workflow_id` so the
    // runs history shows "this run was driven by workflow X"
    // (Codex P2a round 3, 2026-05-10). Built-in templates +
    // stale-fallback paths leave it null.
    workflowId: resolved.workflowId,
    graphSnapshot: linearDef,
    repoPath: settings.linkedRepoPath,
    worktreePath,
    initialStatus: 'pending',
  });
  if (claim.deduped) {
    // CRITICAL: never call `dispatchExisting` on a deduped claim.
    // The winning enqueue already started a dispatch loop for this
    // run; a second `dispatchExisting` call would either no-op
    // (in-process state present) OR — worse, on stale state —
    // start a SECOND dispatcher that races on stage spawns. Use
    // the attach-only path that observes the run from the outside.
    return {
      kind: 'enqueued',
      runId: claim.run.id,
      deduped: true,
      handle: orch.deps.runner.attachExisting(claim.run.id),
    };
  }

  // Materialise the worktree on disk BEFORE the runner spawns any
  // adapter inside it. The L1 adapter contract requires a writable
  // `cwd` at adapter.spawn time; without this step a fresh run
  // failed with ENOENT inside child_process.spawn.
  try {
    await orch.ensureWorktreeFn({
      repoPath: settings.linkedRepoPath,
      worktreeName,
      worktreePath,
    });
  } catch (err) {
    // Mark the claimed row failed so it doesn't sit in pending forever.
    orch.deps.runsRepo.updateRun(claim.run.id, {
      status: 'failed',
      finishedAt: Date.now(),
      lastError: `worktree_setup_failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return {
      kind: 'rejected',
      reason: 'worktree_setup_failed',
      missingDetails: [err instanceof Error ? err.message : String(err)],
    };
  }

  // Re-check stale-enqueue AFTER ensureWorktree. The user may have
  // dragged the card out of `todo` (or toggled auto-code off)
  // during the `git worktree add` (~100ms-1s). If they did, mark
  // the claimed row cancelled + clean up the worktree we just
  // created so the cancelled run doesn't leave detritus on disk.
  const refreshedTask = orch.deps.notes.getById(taskId);
  const refreshedRun = orch.deps.runsRepo.getRun(claim.run.id);
  const cancelledDuringAdmission = refreshedRun?.cancelRequested === true;
  const ticketLeftTodo = !refreshedTask || refreshedTask.status !== 'todo';
  if (cancelledDuringAdmission || ticketLeftTodo) {
    const reason = cancelledDuringAdmission
      ? 'cancelled_during_admission'
      : 'ticket_no_longer_todo';
    const detail = cancelledDuringAdmission
      ? 'cancelRequested flag was set during ensureWorktree (toggle-off / cancelTicket)'
      : `ticket status changed to "${refreshedTask?.status ?? '<deleted>'}" during worktree setup`;
    orch.deps.runsRepo.updateRun(claim.run.id, {
      status: 'cancelled',
      finishedAt: Date.now(),
      lastError: `${reason}: ${detail}`,
    });
    // Best-effort worktree cleanup. Failures here aren't surfaced —
    // the orphan-worktree sweep on next app start (legacy
    // listOrphanWorktrees) catches anything missed.
    orch.cleanupWorktreeFn({
      repoPath: settings.linkedRepoPath,
      worktreeName,
      worktreePath,
    }).catch(() => {});
    return {
      kind: 'rejected',
      reason,
      missingDetails: [detail],
    };
  }

  const handle = orch.deps.runner.dispatchExisting({
    runId: claim.run.id,
    ticketContext,
    hooks: buildHooks(orch, taskId, worktreeName),
  });

  return {
    kind: 'enqueued',
    runId: handle.runId,
    deduped: handle.deduped,
    handle,
  };
}
