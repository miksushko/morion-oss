/**
 * Auto-code merge family — 5 mutating endpoints that drive the
 * "Merge into main" affordance + conflict resolution flow in
 * AutoCodeDrawer.
 *
 * - POST /api/auto-code/runs/:id/merge                    — happy-path
 *     merge worktree branch → trunk.
 * - POST /api/auto-code/runs/:id/merge-conflict-prepare   — conflict
 *     state introspection (ours/theirs/merged per UU file). Serialised
 *     per-repo via `RepoMergeLock` (StrictMode double-fire guard).
 * - POST /api/auto-code/runs/:id/merge-apply-resolution   — commit
 *     user-resolved files (path-traversal hardened, conflict-marker
 *     rejected).
 * - POST /api/auto-code/runs/:id/merge-ai-resolve         — LLM
 *     conflict resolver with primary + fallback model + per-file cost
 *     cap + workspace budget gate.
 * - POST /api/auto-code/runs/:id/merge-abort              — clear
 *     MERGE_HEAD + UU state.
 *
 * Each handler lives in its own file under `auto-code-merge/`. This
 * module is the composer — it owns the per-repo merge mutex (shared
 * state between the prepare path and any future serialised route) and
 * registers the routes in the original order (matters for Hono trie
 * semantics — pinned by `tests/concierge-route-registration.test.ts`).
 *
 * Library-level coverage:
 *   - merge-worktree.test.ts (mergeWorktreeIntoTarget) 6 cases.
 *   - merge-conflict-resolver.test.ts 18 cases (state probe + apply +
 *     path-traversal + commit-hook rejection + abort).
 *   - merge-resolver-ai.test.ts 11 cases (primary / fallback / cost
 *     cap / parallel resolution).
 *
 * Originally extracted from `src/server/routes/concierge.ts` (slice
 * 12/N of the route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F);
 * per-route split shipped under ticket 01KRQS9E0WWXWCWZAZVV2XQ9WC.
 */

import type { Hono } from 'hono';
import type { ToolContext } from '../../tools/types.js';
import { createRepoMergeLock } from './auto-code-merge/repo-merge-lock.js';
import { registerMergeRoute } from './auto-code-merge/merge.js';
import { registerPrepareRoute } from './auto-code-merge/prepare.js';
import { registerApplyRoute } from './auto-code-merge/apply.js';
import { registerAiResolveRoute } from './auto-code-merge/ai-resolve.js';
import { registerAbortRoute } from './auto-code-merge/abort.js';

export function registerAutoCodeMergeRoutes(
  app: Hono,
  ctx: ToolContext,
): void {
  // Per-repo merge mutex — see `repo-merge-lock.ts` for the React
  // StrictMode race incident this guards against. Currently the
  // prepare path is the only consumer; if other merge routes start
  // taking the lock, share this instance via the registration call.
  const withRepoMergeLock = createRepoMergeLock();

  // Registration order matches the original inline order. Don't
  // reorder without checking `tests/concierge-route-registration.test.ts`
  // — Hono trie semantics treat earlier registrations as higher
  // priority for parameterised paths.
  registerMergeRoute(app, ctx);
  registerPrepareRoute(app, ctx, withRepoMergeLock);
  registerApplyRoute(app, ctx);
  registerAiResolveRoute(app, ctx);
  registerAbortRoute(app, ctx);
}
