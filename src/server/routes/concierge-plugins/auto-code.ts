import type { Hono } from 'hono';
import type { ToolContext } from '../../tools/types.js';
import { registerAutoCodeBudgetRoutes } from '../concierge/auto-code-budget.js';
import { registerAutoCodeFolderRoutes } from '../concierge/auto-code-folder.js';
import { registerAutoCodeMergeRoutes } from '../concierge/auto-code-merge.js';
import { registerAutoCodeQueueRoutes } from '../concierge/auto-code-queue.js';
import { registerAutoCodeRunsRoutes } from '../concierge/auto-code-runs.js';
import { registerAutoCodeWorkflowsRoutes } from '../concierge/auto-code-workflows.js';
import type { ConciergeRoutePlugin } from './types.js';

/**
 * Auto-code HTTP surface plugin. MASTER ONLY — excluded from the public
 * OSS export (scripts/export-public.mjs EXCLUDE list). In the public
 * build, `concierge-plugins/index.public.ts` (an empty array, swapped to
 * index.ts at export) takes over so the server compiles + runs without
 * the auto-code routes.
 *
 * Folder-scoped enqueue/tick, queue/transcript, workspace budget, custom
 * workflow CRUD, runs read-only, and the merge family (5 handlers around
 * the `git merge` state machine).
 *
 * Internal registration order MUST preserve the Hono trie invariants
 * pinned by tests/concierge-route-registration.test.ts:
 *   - `/auto-code/runs/batch` BEFORE `/auto-code/runs/:id/*`
 *     (runs module registers before the merge family)
 *   - `/auto-code/workflows` (list) BEFORE `/auto-code/workflows/:id`
 */
export const autoCodeConciergePlugin: ConciergeRoutePlugin = {
  register(app: Hono, ctx: ToolContext): void {
    registerAutoCodeFolderRoutes(app, ctx);
    registerAutoCodeRunsRoutes(app, ctx);
    registerAutoCodeMergeRoutes(app, ctx);
    registerAutoCodeQueueRoutes(app, ctx);
    registerAutoCodeBudgetRoutes(app, ctx);
    registerAutoCodeWorkflowsRoutes(app, ctx);
  },
};
