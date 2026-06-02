/**
 * POST /api/auto-code/runs/:id/merge-ai-resolve
 *
 * Body: empty (the route reads the current MERGE_HEAD state + ticket
 * context from DB itself). Returns proposed resolutions per file +
 * cost + which model produced each. UI populates the editor drafts
 * and the user clicks Apply & merge as usual.
 *
 * Cost-capped: gates on the workspace-wide auto-code monthly budget
 * AND on a hard `MAX_FILES=10` cap to keep per-call spend
 * predictable. Records spend in MoSpendLedger as
 * `auto-code-merge-resolve` so usage breakdowns include this category.
 */
import type { Context, Hono } from 'hono';
import { readMergeConflictState } from '../../../../core/auto-code/merge-conflict-resolver.js';
import { resolveConflictsWithAI } from '../../../../core/auto-code/merge-resolver-ai.js';
import {
  AUTO_CODE_MONTHLY_CAP_USD,
  BudgetTracker,
} from '../../../../core/concierge/budget.js';
import { MoSpendLedgerRepository } from '../../../../core/concierge/mo-spend-ledger.js';
import { WorkflowRunsRepository } from '../../../../core/auto-code/workflows/runs-repository.js';
import { detectClaudeAuthSource } from '../../../features/auto-code-factory/index.js';
import {
  resolveGatherProvider,
  resolveMergeResolverModels,
  type ConciergeDepsHost,
} from '../../../features/concierge-deps/index.js';
import type { ToolContext } from '../../../tools/types.js';
import { requireConciergeDeps, resolveAutoCodeRunWorktree } from '../shared.js';

const MAX_FILES = 10;

export function registerAiResolveRoute(app: Hono, ctx: ToolContext): void {
  app.post('/api/auto-code/runs/:id/merge-ai-resolve', (c) =>
    handleAiResolve(c, ctx, c.req.param('id')),
  );
}

async function handleAiResolve(c: Context, ctx: ToolContext, runId: string) {
  const resolved = resolveAutoCodeRunWorktree(ctx, runId);
  if (!resolved.ok) return c.json(resolved.body, resolved.status);

  // The merge must already be in mid-state (the resolver UI got here
  // via prepare). Read the conflict files for the ticket.
  const state = await readMergeConflictState(resolved.repoPath);
  if (!state.ok) {
    return c.json({ ok: false, error: state.error, message: state.message }, 500);
  }
  if (!state.inProgress) {
    return c.json(
      {
        ok: false,
        error: 'no_merge_in_progress',
        message:
          'No merge is currently in progress. Run merge-conflict-prepare first.',
      },
      409,
    );
  }

  // Filter out binary + content-less files — can't text-resolve.
  const resolvable = state.files.filter(
    (f) => !f.binary && f.ours !== null && f.theirs !== null,
  );
  if (resolvable.length === 0) {
    return c.json(
      {
        ok: false,
        error: 'no_resolvable_files',
        message:
          'All conflicts are binary or have content larger than the 200 KB cap. Resolve manually.',
      },
      409,
    );
  }
  // Cap file count to keep cost predictable.
  if (resolvable.length > MAX_FILES) {
    return c.json(
      {
        ok: false,
        error: 'too_many_files',
        message: `${resolvable.length} files in conflict — cap is ${MAX_FILES}. Resolve manually.`,
      },
      409,
    );
  }

  // Resolve provider + models.
  const bag = requireConciergeDeps(ctx);
  if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
  // ConciergeDepsHost is a subset of ToolContext — assemble inline
  // (mirrors the pattern in `buildWorkflowOrchestrator`). The
  // `concierge` bag is required by ConciergeDepsHost but optional on
  // ToolContext; we already gated above via `requireConciergeDeps` so
  // the narrowing is safe.
  if (!ctx.concierge) {
    return c.json({ error: 'concierge_not_wired' }, 501);
  }
  const host: ConciergeDepsHost = {
    db: ctx.db,
    notes: ctx.notes,
    folders: ctx.folders,
    comments: ctx.comments,
    settings: ctx.settings,
    concierge: ctx.concierge,
    embeddings: ctx.embeddings,
  };
  const providerEnvelope = resolveGatherProvider(host);
  if (!providerEnvelope) {
    return c.json(
      {
        ok: false,
        error: 'provider_not_configured',
        message:
          'AI auto-resolve needs an OpenRouter key (or test provider override). Configure in Settings → Ask Mo.',
      },
      409,
    );
  }
  const models = resolveMergeResolverModels(host);
  if (!models) {
    return c.json(
      {
        ok: false,
        error: 'models_not_configured',
        message: 'Could not resolve merge-resolver model settings.',
      },
      500,
    );
  }

  // Workspace-wide auto-code budget gate. Use the same path as the
  // fix/review cap so a heavy merge-resolve session can't exhaust the
  // user's cap silently.
  const ledger = new MoSpendLedgerRepository(ctx.db);
  const capRaw = ctx.settings.get<number>(
    'auto_code.monthly_budget_usd',
    AUTO_CODE_MONTHLY_CAP_USD,
  );
  const cap =
    typeof capRaw === 'number' && capRaw >= 0 ? capRaw : AUTO_CODE_MONTHLY_CAP_USD;
  const tracker = new BudgetTracker(ledger);
  const acStatus = tracker.autoCodeStatus(cap);
  if (!acStatus.withinBudget) {
    return c.json(
      {
        ok: false,
        error: 'budget_exceeded',
        message: `Auto-code monthly budget exhausted: $${acStatus.spentMonthUsd.toFixed(2)} / $${acStatus.monthlyCapUsd}. Resets ${new Date(acStatus.resetsAt).toISOString().slice(0, 10)}.`,
      },
      429,
    );
  }

  // Read ticket context from notes repo.
  const wfRepo = new WorkflowRunsRepository(ctx.db);
  const run = wfRepo.getRun(runId);
  let title = 'unknown ticket';
  let bodyExcerpt = '';
  let targetBranch = 'main';
  let worktreeBranch = resolved.worktreeName;
  if (run) {
    const note = ctx.notes.getById(run.ticketId);
    if (note) {
      title = note.title || title;
      bodyExcerpt = (note.body ?? '').slice(0, 1500);
    }
    worktreeBranch = run.worktreePath.split('/').pop() ?? worktreeBranch;
  }
  // Best-effort detect actual target branch — for the prompt only.
  // The merge state knows what HEAD was at prepare time; we just
  // report `main` / `master` as a hint to the model.
  if (state.headRef) {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      const r = await exec(
        'git',
        [
          '-C',
          resolved.repoPath,
          'symbolic-ref',
          '--quiet',
          '--short',
          'HEAD',
        ],
        { timeout: 5_000 },
      );
      targetBranch = r.stdout.trim() || targetBranch;
    } catch {
      // No-op — `main` placeholder is fine for the prompt.
    }
  }

  const batch = await resolveConflictsWithAI({
    provider: providerEnvelope.provider,
    primaryModel: models.primaryModel,
    fallbackModel: models.fallbackModel,
    files: resolvable.map((f) => ({
      path: f.path,
      ours: f.ours ?? '',
      theirs: f.theirs ?? '',
      merged: f.merged,
    })),
    ticketContext: { title, bodyExcerpt },
    branches: { targetBranch, worktreeBranch },
  });

  // Record the actual spend in the ledger so the workspace budget
  // breakdown surfaces it. Slice 12 of ticket 01KRJSTN74FT7VRX6KAA42GGBS
  // — merge-resolver calls Claude (sonnet primary, opus fallback) via
  // the same OAuth Max session as the rest of auto-code; stamp
  // authMode so a Max-plan resolve lands as 'subscription'.
  if (batch.totalCostUsd > 0) {
    const authSource = detectClaudeAuthSource();
    tracker.record({
      kind: 'auto-code-merge-resolve',
      folderId: run?.folderId ?? null,
      costUsd: batch.totalCostUsd,
      authMode:
        authSource === 'oauth-max'
          ? 'subscription'
          : authSource === 'api-key'
            ? 'api'
            : null,
    });
  }

  return c.json({
    ok: true,
    results: batch.results,
    totalCostUsd: batch.totalCostUsd,
    okCount: batch.okCount,
    failedCount: batch.failedCount,
    anyFallback: batch.anyFallback,
    primaryModel: models.primaryModel,
    fallbackModel: models.fallbackModel,
  });
}
