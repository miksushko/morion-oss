/**
 * POST /api/auto-code/runs/:id/merge-abort
 *
 * Cancel flow — runs `git merge --abort` and leaves trunk clean. The
 * ConflictResolverModal hits this when the user gives up on a
 * mid-state conflict; equivalent to manually running the same
 * command in the repo's main checkout.
 */
import type { Context, Hono } from 'hono';
import { abortMerge } from '../../../../core/auto-code/merge-conflict-resolver.js';
import type { ToolContext } from '../../../tools/types.js';
import { resolveAutoCodeRunWorktree } from '../shared.js';

export function registerAbortRoute(app: Hono, ctx: ToolContext): void {
  app.post('/api/auto-code/runs/:id/merge-abort', (c) =>
    handleAbort(c, ctx, c.req.param('id')),
  );
}

async function handleAbort(c: Context, ctx: ToolContext, runId: string) {
  const resolved = resolveAutoCodeRunWorktree(ctx, runId);
  if (!resolved.ok) return c.json(resolved.body, resolved.status);
  const result = await abortMerge(resolved.repoPath);
  if (!result.ok) return c.json(result, 500);
  return c.json(result);
}
