/**
 * POST /api/auto-code/runs/:id/merge-apply-resolution
 *
 * Body: `{resolvedFiles: {[path]: content}, commitMessage?}`.
 *
 * Writes resolved content, `git add`, `git commit` — completes the
 * merge that was left mid-state by prepare. Path-traversal hardened
 * + leftover conflict-marker rejected (both gated in
 * `applyResolution` from the library layer).
 */
import type { Context, Hono } from 'hono';
import { applyResolution } from '../../../../core/auto-code/merge-conflict-resolver.js';
import { AUTO_CODE_ACTOR } from '../../../../core/auto-code/actor-constants.js';
import { WorkflowRunsRepository } from '../../../../core/auto-code/workflows/runs-repository.js';
import type { ToolContext } from '../../../tools/types.js';
import { resolveAutoCodeRunWorktree } from '../shared.js';

export function registerApplyRoute(app: Hono, ctx: ToolContext): void {
  app.post('/api/auto-code/runs/:id/merge-apply-resolution', (c) =>
    handleApply(c, ctx, c.req.param('id')),
  );
}

async function handleApply(c: Context, ctx: ToolContext, runId: string) {
  const resolved = resolveAutoCodeRunWorktree(ctx, runId);
  if (!resolved.ok) return c.json(resolved.body, resolved.status);

  // Codex P1.4 — mirror /merge's run.status === 'done' gate.
  {
    const wfRepoGate = new WorkflowRunsRepository(ctx.db);
    const runGate = wfRepoGate.getRun(runId);
    if (runGate && runGate.status !== 'done') {
      return c.json(
        {
          ok: false,
          error: 'run_not_done',
          message: `Run is in state "${runGate.status}" — only "done" runs can be applied. Re-run auto-code first.`,
        },
        409,
      );
    }
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json(
      {
        ok: false,
        error: 'invalid_body',
        message:
          'Body must be {resolvedFiles: {[path]: string}, commitMessage?: string}.',
      },
      400,
    );
  }
  const resolvedFilesRaw = (body as Record<string, unknown>).resolvedFiles;
  if (
    !resolvedFilesRaw ||
    typeof resolvedFilesRaw !== 'object' ||
    Array.isArray(resolvedFilesRaw)
  ) {
    return c.json(
      {
        ok: false,
        error: 'invalid_body',
        message: '`resolvedFiles` must be an object map of path → string content.',
      },
      400,
    );
  }
  const resolvedFiles: Record<string, string> = {};
  for (const [k, v] of Object.entries(resolvedFilesRaw as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      return c.json(
        {
          ok: false,
          error: 'invalid_body',
          message: `resolvedFiles["${k}"] must be a string.`,
        },
        400,
      );
    }
    resolvedFiles[k] = v;
  }
  const commitMessage =
    typeof (body as Record<string, unknown>).commitMessage === 'string'
      ? ((body as Record<string, unknown>).commitMessage as string)
      : undefined;

  const result = await applyResolution({
    repoPath: resolved.repoPath,
    resolvedFiles,
    commitMessage,
  });

  if (!result.ok) {
    const httpStatus =
      result.error === 'no_merge_in_progress' ||
      result.error === 'leftover_markers'
        ? 409
        : 500;
    return c.json(result, httpStatus);
  }

  // Mark the workflow run as merged + post the same activity footprint
  // comment the regular merge route does.
  const wfRepo = new WorkflowRunsRepository(ctx.db);
  const run = wfRepo.getRun(runId);
  if (run) {
    wfRepo.markMerged(runId);
    try {
      const stat = result.stat ? ` (${result.stat})` : '';
      const fileList = result.resolved.map((p) => `\`${p}\``).join(', ');
      ctx.comments.create(
        run.ticketId,
        `✓ Merged into trunk with manual conflict resolution. ${result.resolved.length} file(s) resolved: ${fileList}${stat}.\n\nMerge commit: \`${result.sha}\`. The files are now on your trunk checkout. Open the repo via **Show files** in the drawer, or jump straight into your editor.`,
        AUTO_CODE_ACTOR,
        null,
      );
    } catch (err) {
      console.error('[merge-apply-resolution] post-merge comment failed:', err);
    }
  }

  return c.json(result);
}
