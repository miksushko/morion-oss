import type { ConciergeRoutePlugin } from './types.js';

/**
 * Public OSS build: no concierge route plugins. The auto-code HTTP
 * surface lives only in the private master repo.
 *
 * scripts/export-public.mjs swaps this file to `index.ts` at export
 * time (SWAP map) and excludes `auto-code.ts` (EXCLUDE list).
 */
export const conciergeRoutePlugins: ConciergeRoutePlugin[] = [];
