import { autoCodeConciergePlugin } from './auto-code.js';
import type { ConciergeRoutePlugin } from './types.js';

/**
 * Concierge route plugins loaded in the MASTER (full) build.
 *
 * The public OSS export swaps this file for `index.public.ts` (an empty
 * array) via the scripts/export-public.mjs SWAP map, and EXCLUDES
 * `auto-code.ts`. That lets the public server compile + run without the
 * auto-code HTTP surface while `routes/concierge.ts` (the composer) ships
 * byte-identical to both repos.
 */
export const conciergeRoutePlugins: ConciergeRoutePlugin[] = [
  autoCodeConciergePlugin,
];
