import type { Hono } from 'hono';
import type { ToolContext } from '../tools/types.js';
import { conciergeRoutePlugins } from './concierge-plugins/index.js';
import type { ConciergeRoutePlugin } from './concierge-plugins/types.js';
import { registerFindingsRoutes } from './concierge/findings.js';
import { registerFolderCatalogRoutes } from './concierge/folder-catalog.js';
import { registerFolderRisksLogsRoutes } from './concierge/folder-risks-logs.js';
import { registerFolderSettingsRoutes } from './concierge/folder-settings.js';
import { registerFolderTopicsRoutes } from './concierge/folder-topics.js';
import { registerIndexingTickRoutes } from './concierge/indexing-tick.js';
import { registerMoMemoryRoutes } from './concierge/mo-memory.js';
import { registerProviderSettingsRoutes } from './concierge/provider-settings.js';
import { registerSessionMessagesRoutes } from './concierge/session-messages.js';
import { registerSessionsRoutes } from './concierge/sessions.js';
import { registerUsageRoutes } from './concierge/usage.js';

/**
 * Direction V — Concierge HTTP surface (Phase V4).
 *
 * Pro-gated at every mutation + Launch. Reads (settings, sessions,
 * messages, budget) stay open on Free so a Free user can see what the
 * feature would give them without hitting 402 on passive GET. The tier
 * check short-circuits to a `pro_required` envelope that matches the
 * kanban-quota + license-activate shape the UI already knows.
 *
 * Provider wiring: the active backend lives in `concierge.backend`.
 * Each backend gets its own key + model settings so a Kimi model
 * saved for OpenRouter can't accidentally be sent to Groq. Env vars
 * remain dev / ops fallbacks. Read at each request so a freshly-
 * pasted key takes effect without restart. Key absence falls back
 * to `NoopLLMProvider` — engine still runs end-to-end but the
 * assistant content is the "not configured" message.
 *
 * As of the route-file split (ticket 01KRJYX50FMDQ94V3464T56K5F),
 * this file is just composition. Each domain has its own module
 * under `./concierge/` registering its routes via `register*Routes`.
 * The split is pinned by `tests/concierge-route-registration.test.ts`
 * which asserts every (method, path) pair below stays registered
 * regardless of which module owns it now.
 *
 * Hono trie ordering invariant — these three pairs MUST stay in
 * registration order:
 *   - `/sessions/search` BEFORE `/sessions/:id`
 *     (both in concierge/sessions.ts)
 *   - `/auto-code/runs/batch` BEFORE `/auto-code/runs/:id/*`
 *     (both in concierge/auto-code-runs.ts; merge family in
 *      auto-code-merge.ts registers after — its :id/merge* never
 *      conflicts with the literal "batch")
 *   - `/auto-code/workflows` (list) BEFORE `/auto-code/workflows/:id`
 *     (both in concierge/auto-code-workflows.ts)
 *
 * Provider routing (BACKEND_CONFIGS, BACKEND_FACTORIES, defaults)
 * lives in `src/server/concierge-deps.ts` — shared with the
 * scheduler so the route + scheduler can never drift on which
 * model id pairs with which backend (ticket `01KQ1H4YVKJFVE05PG9WZBAB7E`).
 */
export function registerConciergeRoutes(app: Hono, ctx: ToolContext): void {
  // Every route in this file requires the concierge bag. Each
  // register*Routes module re-checks per-handler and returns a
  // 501 `concierge_not_wired` envelope when the bag is missing.

  // Folder-scoped feature tabs.
  registerFolderSettingsRoutes(app, ctx);
  registerFolderCatalogRoutes(app, ctx);
  registerFolderTopicsRoutes(app, ctx);
  registerFolderRisksLogsRoutes(app, ctx);
  registerIndexingTickRoutes(app, ctx);
  registerFindingsRoutes(app, ctx);

  // Ask Mo — session CRUD then chat dispatch.
  registerSessionsRoutes(app, ctx);
  registerSessionMessagesRoutes(app, ctx);

  // Workspace-level Mo settings.
  registerProviderSettingsRoutes(app, ctx);
  registerMoMemoryRoutes(app, ctx);

  // Usage stats (Settings → Usage tab — ticket 01KRJSTN74FT7VRX6KAA42GGBS).
  // Reads-only; pure aggregator over `mo_spend_ledger` + the two cap
  // statuses so the dashboard renders both progress bars from one GET.
  registerUsageRoutes(app, ctx);

  // Pluggable surfaces (auto-code) register LAST, after every core
  // route. MASTER loads the auto-code plugin; the public OSS export
  // loads none (empty array from concierge-plugins/index.public.ts).
  // Registering after core is safe — no auto-code route shares a Hono
  // trie prefix with a core route (the within-family ordering pins in
  // tests/concierge-route-registration.test.ts live inside each plugin).
  for (const plugin of conciergeRoutePlugins) {
    plugin.register(app, ctx);
  }

  // GET /api/concierge/actions was deleted alongside the autonomous Mo
  // agent (ticket `01KQVA65TJ2VCY8VCKH9N5F6W8`, 2026-05-05). Nothing
  // writes to the `concierge_actions` table any more, so the workspace
  // Action log tab and `listConciergeActions` API client method are gone.
}

// Back-compat re-export so callers importing the plugin contract from
// the composer module keep working after the concierge-plugins split.
export type { ConciergeRoutePlugin };
