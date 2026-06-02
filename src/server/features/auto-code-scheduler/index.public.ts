import type { AutoCodeSchedulerWiring } from './types.js';

/**
 * Public OSS build: no auto-code scheduler wiring. The Concierge
 * scheduler runs Mo-indexing + topic-hygiene only.
 *
 * scripts/export-public.mjs swaps this file to `index.ts` at export
 * time (SWAP map) and excludes the master `index.ts` (EXCLUDE list).
 * `bootstrap/start.ts` guards every call behind `?.`, so a `null`
 * wiring cleanly disables all auto-code startup work.
 */
export const autoCodeSchedulerWiring: AutoCodeSchedulerWiring | null = null;
