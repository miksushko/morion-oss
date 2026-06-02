/**
 * Barrel for shared concierge route helpers.
 *
 * Originally a single 605-LOC file accumulated during the route-file
 * split (ticket `01KRJYX50FMDQ94V3464T56K5F`). Re-split 2026-05-16
 * (ticket `01KRQYS1T925XEWBBJJYRJBGE2`) into per-domain modules under
 * `./shared/`. 22 importers across the concierge route family stay
 * unchanged — they import from this barrel.
 *
 * Forward-looking rule: when adding a new shared helper, drop it into
 * the most cohesive sibling (or create a new one) and re-export here.
 * Don't add inline definitions to this file.
 */

export {
  CHAT_DESTRUCTIVE_BATCH_SIZE,
  MAX_TOOL_TURNS,
  USER_ACTOR,
  requireConciergeDeps,
  slugifyTopicName,
  asHost,
} from './shared/ctx.js';
export { serializeFinding } from './shared/mo-finding.js';
export {
  projectWorkflowRunAsQueue,
  validateLinkedRepo,
  resolveAutoCodeRunWorktree,
} from './shared/autocode-projection.js';
export { extractMatchSnippet, truncatePreview } from './shared/text.js';
export { detectCleanupEscalationContext } from './shared/cleanup-escalation.js';
export { resolveDestructiveTargetLabel } from './shared/destructive.js';
export { resolveProjectCatalog } from './shared/catalog.js';
