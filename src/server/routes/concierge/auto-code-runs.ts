/**
 * Auto-code runs read-only surface + remove-worktree.
 *
 * - GET  /api/auto-code/runs                       — list per task (union legacy + workflow_runs).
 * - GET  /api/auto-code/runs/batch                 — kanban-card badge data (N+1-safe).
 * - GET  /api/auto-code/runs/:id/paused-session    — deep-link target for paused runs.
 * - GET  /api/auto-code/runs/:id/merge-status      — mid-merge state probe.
 * - POST /api/auto-code/runs/:id/remove-worktree   — manual worktree delete.
 * - GET  /api/auto-code/runs/:id/diff-stat         — "What Mo did" plain-English summary.
 * - GET  /api/auto-code/runs/:id/files             — changed-files list.
 * - GET  /api/auto-code/runs/:id/files/content     — before/after content for one path.
 *
 * Hono trie ordering invariant: `/runs/batch` MUST register BEFORE
 * `/runs/:id/*`. The register order below maintains that. Pinned by
 * `tests/concierge-route-registration.test.ts`.
 *
 * The merge family (merge, merge-conflict-prepare, merge-apply-
 * resolution, merge-ai-resolve, merge-abort) lives in
 * `concierge/auto-code-merge.ts` — those 5 mutators share a
 * `git merge` state-machine cohesion that earned its own module.
 *
 * Extracted from `src/server/routes/concierge.ts` (slice 9/N of the
 * route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F). Pure code-
 * motion — behaviour unchanged.
 */

import type { Hono } from 'hono';
import { AgentQueueRepository } from '../../../core/auto-code/queue.js';
import { WorkflowRunsRepository } from '../../../core/auto-code/workflows/runs-repository.js';
import { buildAutoCodeDispatcher } from '../../features/auto-code-factory/index.js';
import type { ToolContext } from '../../tools/types.js';
import {
  projectWorkflowRunAsQueue,
  resolveAutoCodeRunWorktree,
} from './shared.js';

export function registerAutoCodeRunsRoutes(
  app: Hono,
  ctx: ToolContext,
): void {
  // ------- Auto-code runs list (powers the per-task AutoCodeDrawer) -----
  // Returns ALL queue rows for a task newest-first so the drawer can
  // open on the latest run + show a history picker. Pro-gated.
  app.get('/api/auto-code/runs', (c) => {
    const taskId = c.req.query('taskId');
    if (!taskId) return c.json({ error: 'taskId_required' }, 400);
    // Union legacy `mo_agent_queue` rows + new `workflow_runs` rows so
    // the AutoCodeDrawer run picker shows BOTH engines' history (Phase
    // 4.5 routing flip put new runs in workflow_runs; without the
    // union the picker only showed stale legacy rows from before the
    // flip, defaulting on a months-old cancelled run instead of the
    // fresh workflow_runs `done`).
    const agentQueue = new AgentQueueRepository(ctx.db);
    const legacy = agentQueue.listForTask(taskId, 50);
    const wfRepo = new WorkflowRunsRepository(ctx.db);
    const wfRuns = wfRepo.listForTicket(taskId, 50);
    const merged: ReturnType<typeof projectWorkflowRunAsQueue>[] = [
      ...legacy.map((r) => r as unknown as ReturnType<typeof projectWorkflowRunAsQueue>),
      ...wfRuns.map((r) => projectWorkflowRunAsQueue(r, wfRepo)),
    ];
    // Newest-first by `createdAt` (both shapes have the field — legacy
    // = mo_agent_queue.created_at, projected wf = workflow_runs.started_at).
    merged.sort((a, b) => b.createdAt - a.createdAt);
    return c.json({ rows: merged.slice(0, 50) });
  });

  // ------- Auto-code runs batch (powers the kanban-card badge) ----------
  // Returns the latest row per task across a batch — one DB hit, no N+1.
  // The kanban view calls this once per render with all visible card ids
  // so every card can paint its auto-code badge in one network round
  // trip. Tasks without any rows are simply absent from the response
  // map (saves wire bytes — kanban folders without auto-code enabled
  // would otherwise carry N empty entries on every refresh).
  app.get('/api/auto-code/runs/batch', async (c) => {
    const raw = c.req.query('taskIds') ?? '';
    const taskIds = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (taskIds.length === 0) return c.json({ rowsByTask: {} });
    // Phase 4.5 routing flip — auto-code now writes to `workflow_runs`
    // (new engine) for default-template folders, not `mo_agent_queue`
    // (legacy). Union both engines so kanban-card badges show up
    // regardless of which engine ran the task. Pick newest by ts.
    const agentQueue = new AgentQueueRepository(ctx.db);
    const legacyMap = agentQueue.listLatestForTasks(taskIds);
    const wfRepo = new WorkflowRunsRepository(ctx.db);
    const wfMap = wfRepo.listLatestForTasks(taskIds);
    type QueueRow = NonNullable<ReturnType<typeof agentQueue.getById>>;
    const out: Record<
      string,
      QueueRow & {
        mergeStatus?:
          | { inProgress: false }
          | {
              inProgress: true;
              isOurMerge: boolean;
              mergeHeadRef: string;
              unresolvedCount: number;
            };
      }
    > = {};
    const repoBuckets = new Map<string, QueueRow[]>();
    for (const taskId of taskIds) {
      const legacy = legacyMap.get(taskId) ?? null;
      const wf = wfMap.get(taskId) ?? null;
      if (!legacy && !wf) continue;
      // Newest run wins. workflow_runs.startedAt vs legacy.createdAt
      // — same epoch ms semantics, safe direct compare.
      const winner: QueueRow =
        legacy && wf
          ? legacy.createdAt > wf.startedAt
            ? legacy
            : projectWorkflowRunAsQueue(wf, wfRepo)
          : (legacy ?? projectWorkflowRunAsQueue(wf!, wfRepo));
      out[taskId] = winner;
      // Bucket by repoPath so we run ONE MERGE_HEAD probe per unique
      // repo even when many rows share the same one (typical kanban
      // view = N rows from a single linked repo).
      if (winner.state === 'done' && winner.repoPath) {
        const bucket = repoBuckets.get(winner.repoPath);
        if (bucket) bucket.push(winner);
        else repoBuckets.set(winner.repoPath, [winner]);
      }
    }

    // Probe each unique repo's MERGE_HEAD once + per-row branch tip
    // compare. Total git ops = O(uniqueRepos) + O(doneRowsInMidMergeRepos).
    // For typical kanban (5-20 done cards from one repo) that's
    // ~6-21 git ops per /batch call — fine for the 4s drawer poll.
    if (repoBuckets.size > 0) {
      const { readMergeConflictState } = await import(
        '../../../core/auto-code/merge-conflict-resolver.js'
      );
      const { worktreeBranchName } = await import(
        '../../../core/auto-code/worktree-paths.js'
      );
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      for (const [repoPath, rows] of repoBuckets) {
        let state;
        try {
          state = await readMergeConflictState(repoPath);
        } catch {
          continue;
        }
        if (!state.ok) continue;
        if (!state.inProgress) {
          for (const row of rows) {
            out[row.taskId]!.mergeStatus = { inProgress: false };
          }
          continue;
        }
        // Mid-merge: per-row branch-tip compare against MERGE_HEAD.
        for (const row of rows) {
          if (!row.worktreeName) {
            out[row.taskId]!.mergeStatus = { inProgress: false };
            continue;
          }
          let ourTip: string | null = null;
          for (const candidate of [
            row.worktreeName,
            worktreeBranchName(row.worktreeName),
          ]) {
            try {
              const r = await exec(
                'git',
                ['-C', repoPath, 'rev-parse', '--verify', '--quiet', candidate],
                { timeout: 5_000 },
              );
              ourTip = r.stdout.trim();
              break;
            } catch {
              // try next.
            }
          }
          out[row.taskId]!.mergeStatus = {
            inProgress: true,
            isOurMerge: ourTip !== null && ourTip === state.mergeHeadRef,
            mergeHeadRef: state.mergeHeadRef,
            unresolvedCount: state.files.length,
          };
        }
      }
    }
    return c.json({ rowsByTask: out });
  });

  // Pro-only deep-link target for paused runs — the AutoCodeDrawer's
  // "Resume in chat" button hits this to find the linked Ask Mo
  // session id (deep-link target) or null when the run isn't paused
  // / has no linked session.
  app.get('/api/auto-code/runs/:id/paused-session', (c) => {
    const runId = c.req.param('id');
    const wfRepo = new WorkflowRunsRepository(ctx.db);
    const run = wfRepo.getRun(runId);
    if (!run) return c.json({ sessionId: null });
    if (run.status !== 'paused_ask_user') return c.json({ sessionId: null });
    return c.json({ sessionId: run.pausedSessionId ?? null });
  });

  app.get('/api/auto-code/runs/:id/merge-status', async (c) => {
    const runId = c.req.param('id');
    const resolved = resolveAutoCodeRunWorktree(ctx, runId);
    if (!resolved.ok) return c.json(resolved.body, resolved.status);

    const { readMergeConflictState } = await import(
      '../../../core/auto-code/merge-conflict-resolver.js'
    );
    const { worktreeBranchName } = await import(
      '../../../core/auto-code/worktree-paths.js'
    );
    const state = await readMergeConflictState(resolved.repoPath);
    if (!state.ok) {
      return c.json({ ok: false, error: state.error, message: state.message }, 500);
    }
    if (!state.inProgress) {
      return c.json({ ok: true, inProgress: false });
    }

    // Probe whether MERGE_HEAD matches THIS run's worktree branch.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    let ourTip: string | null = null;
    for (const candidate of [
      resolved.worktreeName,
      worktreeBranchName(resolved.worktreeName),
    ]) {
      try {
        const r = await exec(
          'git',
          ['-C', resolved.repoPath, 'rev-parse', '--verify', '--quiet', candidate],
          { timeout: 5_000 },
        );
        ourTip = r.stdout.trim();
        break;
      } catch {
        // ignore — try next candidate.
      }
    }
    const isOurMerge = ourTip !== null && ourTip === state.mergeHeadRef;
    return c.json({
      ok: true,
      inProgress: true,
      isOurMerge,
      mergeHeadRef: state.mergeHeadRef,
      ourBranchTip: ourTip,
      unresolvedCount: state.files.length,
    });
  });

  // ------- Worktree cleanup (ticket 01KRFX0PNE4WAFTDYJ3FQPK8F7) -----
  //
  // Manual delete affordance — drawer's More menu surfaces "Delete
  // worktree" for failed / cancelled / done_merged rows. Done-but-not-
  // merged runs go through this route too (the UI shows a confirm
  // warning the user is about to drop unmerged work) — backend
  // doesn't block done-without-merge because the user already
  // confirmed in the UI; backend only blocks ACTIVE runs (still
  // in flight) where losing the worktree would orphan the runner.
  app.post('/api/auto-code/runs/:id/remove-worktree', async (c) => {
    const runId = c.req.param('id');
    const wfRepo = new WorkflowRunsRepository(ctx.db);
    const run = wfRepo.getRun(runId);
    let repoPath: string | null = null;
    let worktreeName: string | null = null;
    let worktreePath: string | null = null;
    if (run) {
      // Block when the runner is still working on it. ACTIVE_RUN_STATUSES
      // (from types.ts) = pending / running / paused_ask_user.
      if (run.status === 'pending' || run.status === 'running' || run.status === 'paused_ask_user') {
        return c.json(
          {
            ok: false,
            error: 'run_active',
            message: `Run is still ${run.status}. Cancel it first, then delete the worktree.`,
          },
          409,
        );
      }
      repoPath = run.repoPath;
      worktreePath = run.worktreePath;
      worktreeName = run.worktreePath.split('/').pop() ?? null;
    } else {
      // Legacy mo_agent_queue row fallback.
      const agentQueue = new AgentQueueRepository(ctx.db);
      const legacyRow = agentQueue.getById(runId);
      if (!legacyRow) {
        return c.json({ ok: false, error: 'run_not_found' }, 404);
      }
      if (
        legacyRow.state === 'pending' ||
        legacyRow.state === 'fix_running' ||
        legacyRow.state === 'fix_review' ||
        legacyRow.state === 'review_running' ||
        legacyRow.state === 'reopened'
      ) {
        return c.json(
          {
            ok: false,
            error: 'run_active',
            message: `Legacy run is still ${legacyRow.state}. Cancel it first.`,
          },
          409,
        );
      }
      repoPath = legacyRow.repoPath;
      worktreeName = legacyRow.worktreeName;
      if (worktreeName) {
        worktreePath = `${legacyRow.repoPath}/.morion/worktrees/${worktreeName}`;
      }
    }
    if (!repoPath || !worktreeName || !worktreePath) {
      // Nothing to do — no worktree was ever provisioned (the run
      // failed before ensureWorktree ran). Return ok=true,
      // removed=false so the UI shows a friendly "already gone".
      return c.json({ ok: true, removed: false, reason: 'no_worktree_recorded' });
    }
    // Try the new path first; legacy `.claude/worktrees/...` is also
    // a candidate for pre-rename runs (commit 8226516 moved
    // `.claude/` → `.morion/`). Probe both.
    const { existsSync } = await import('node:fs');
    const morionPath = `${repoPath}/.morion/worktrees/${worktreeName}`;
    const claudePath = `${repoPath}/.claude/worktrees/${worktreeName}`;
    const target = existsSync(morionPath)
      ? morionPath
      : existsSync(claudePath)
        ? claudePath
        : worktreePath;
    if (!existsSync(target)) {
      return c.json({ ok: true, removed: false, reason: 'already_gone' });
    }
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    try {
      await exec('git', ['-C', repoPath, 'worktree', 'remove', '--force', target], {
        timeout: 30_000,
      });
      // Best-effort prune so the git ref-list reflects reality.
      try {
        await exec('git', ['-C', repoPath, 'worktree', 'prune'], { timeout: 10_000 });
      } catch {
        // non-fatal
      }
      // Footprint comment on the ticket so the activity feed shows
      // someone cleaned up. Skip for legacy rows — no ticket-id link.
      if (run) {
        ctx.comments.create(
          run.ticketId,
          `🧹 Worktree \`${worktreeName}\` removed (manual cleanup).`,
          'mcp:auto-code',
          null,
        );
      }
      return c.json({ ok: true, removed: true, path: target });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const message = (e.stderr || e.message || String(err)).trim().slice(0, 500);
      return c.json(
        {
          ok: false,
          error: 'git_error',
          message: `git worktree remove failed: ${message}`,
        },
        500,
      );
    }
  });

  // ------- Cancel / Stop an in-flight run -----------------------------
  // The explicit "Stop" affordance in the AutoCodeDrawer RunStatusBar.
  // Resolves folderId + ticketId from the run id, then fans a cancel
  // across BOTH engines via the dispatcher (legacy mo_agent_queue +
  // workflow_runs). Because buildAutoCodeDispatcher now returns the
  // process-shared WorkflowRunner (runner-singleton.ts), this reaches the
  // LIVE cli_agent adapter handle and SIGTERMs the running process —
  // without the singleton it only flipped the DB flag and let the current
  // stage burn to completion.
  app.post('/api/auto-code/runs/:id/cancel', async (c) => {
    const runId = c.req.param('id');
    const wfRepo = new WorkflowRunsRepository(ctx.db);
    const run = wfRepo.getRun(runId);
    let folderId: string;
    let ticketId: string;
    if (run) {
      folderId = run.folderId;
      ticketId = run.ticketId;
    } else {
      const legacyRow = new AgentQueueRepository(ctx.db).getById(runId);
      if (!legacyRow) return c.json({ ok: false, error: 'run_not_found' }, 404);
      folderId = legacyRow.folderId;
      ticketId = legacyRow.taskId;
    }
    const dispatcher = await buildAutoCodeDispatcher(ctx);
    const summary = await dispatcher.cancelTicket(folderId, ticketId, 'user_stop');
    return c.json({ ok: true, summary });
  });

  // ------- Auto-code run summary (Feature 1 — "What Mo did") ---------
  // Powers the AutoCodeDrawer's plain-English summary section above
  // the transcript tabs. Cheap on-demand compute — never persisted,
  // never embedded in the queue/run row shape (would cost a `git diff`
  // per row on every kanban open). Pro-gated to match the rest of
  // the auto-code surface.
  app.get('/api/auto-code/runs/:id/diff-stat', async (c) => {
    const runId = c.req.param('id');
    const wfRepo = new WorkflowRunsRepository(ctx.db);
    const run = wfRepo.getRun(runId);
    if (run) {
      // Workflow runs — derive worktreeName from worktreePath and
      // call the shared helper.
      const worktreeName = run.worktreePath.split('/').pop() ?? '';
      if (!worktreeName) {
        return c.json({
          ok: false,
          error: 'invalid_worktree_path',
          message: `Could not derive worktree name from ${run.worktreePath}.`,
        });
      }
      const { computeRunDiffStat } = await import('../../../core/auto-code/run-summary.js');
      const stat = await computeRunDiffStat({
        repoPath: run.repoPath,
        worktreeName,
      });
      return c.json(stat);
    }
    // Legacy `mo_agent_queue` row fallback. Older runs still need
    // a summary for back-compat in the drawer's run picker.
    const agentQueue = new AgentQueueRepository(ctx.db);
    const legacyRow = agentQueue.getById(runId);
    if (!legacyRow) {
      return c.json({ ok: false, error: 'run_not_found', message: `Run ${runId} not found.` }, 404);
    }
    if (!legacyRow.worktreeName) {
      return c.json({
        ok: false,
        error: 'no_worktree',
        message: 'Legacy queue row has no worktree.',
      });
    }
    const { computeRunDiffStat } = await import('../../../core/auto-code/run-summary.js');
    const stat = await computeRunDiffStat({
      repoPath: legacyRow.repoPath,
      worktreeName: legacyRow.worktreeName,
    });
    return c.json(stat);
  });

  // ------- Auto-code file picker (Feature 2 — "Show files") ----------
  // Two endpoints:
  //   GET /api/auto-code/runs/:id/files       — list of changed paths
  //   GET /api/auto-code/runs/:id/files/content?path=… — before/after content
  // Both Pro-gated. Compute is cheap (`git diff` against trunk) and not
  // cached server-side; UI fetches on demand when the user expands the
  // "Show files" section.
  app.get('/api/auto-code/runs/:id/files', async (c) => {
    const runId = c.req.param('id');
    const resolved = resolveAutoCodeRunWorktree(ctx, runId);
    if (!resolved.ok) return c.json(resolved.body, resolved.status);
    const { listChangedFiles } = await import('../../../core/auto-code/run-files.js');
    const result = await listChangedFiles({
      repoPath: resolved.repoPath,
      worktreeName: resolved.worktreeName,
    });
    return c.json(result);
  });

  app.get('/api/auto-code/runs/:id/files/content', async (c) => {
    const runId = c.req.param('id');
    const path = c.req.query('path') ?? '';
    if (!path) {
      return c.json({ ok: false, error: 'missing_path', message: 'path query param is required.' }, 400);
    }
    const resolved = resolveAutoCodeRunWorktree(ctx, runId);
    if (!resolved.ok) return c.json(resolved.body, resolved.status);
    const { readFileBeforeAfter } = await import('../../../core/auto-code/run-files.js');
    const result = await readFileBeforeAfter({
      repoPath: resolved.repoPath,
      worktreeName: resolved.worktreeName,
      path,
    });
    return c.json(result);
  });
}
