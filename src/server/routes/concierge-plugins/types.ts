import type { Hono } from 'hono';
import type { ToolContext } from '../../tools/types.js';

/**
 * A pluggable group of concierge HTTP routes registered AFTER the
 * always-on core routes in `registerConciergeRoutes`.
 *
 * The MASTER build loads the auto-code plugin (`concierge-plugins/index.ts`);
 * the public OSS export swaps in `index.public.ts` (empty array) and
 * excludes `auto-code.ts`, so the composer (`routes/concierge.ts`) ships
 * byte-identical to both repos. See `concierge-plugins/index.ts`.
 */
export interface ConciergeRoutePlugin {
  register(app: Hono, ctx: ToolContext): void;
}
