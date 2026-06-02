/**
 * Concierge route helpers — `ToolContext` adaptation + topic-name slug + shared
 * caps. Extracted from `../shared.ts` (2026-05-16, ticket
 * `01KRQYS1T925XEWBBJJYRJBGE2`).
 */

import type { ConciergeDepsHost } from '../../../features/concierge-deps/index.js';
import type { ToolContext } from '../../../tools/types.js';

/**
 * Server-side ceiling on destructive tool calls per turn. Mirrors the
 * chat system-prompt cap (`CHAT_BULK_DESTRUCTIVE_RULES` in
 * core/concierge/prompt.ts). Both numbers must match — keep them in
 * sync. The prompt asks the model to self-cap; this is the hard
 * fallback when the model overshoots (small models often do). The
 * loop slices the destructive calls down to this size, defers the
 * rest with a synthetic tool-result, and persists a notice in the
 * approval-card preface. Ticket 01KQ21XVVB7QV20JSE4R7SR1AF.
 */
export const CHAT_DESTRUCTIVE_BATCH_SIZE = 10;

/**
 * Cap on tool-call rounds per chat reply (`/messages` or `/tool-approve`).
 *
 * Why 8 (was 4, 2026-04-25 ticket `01KQ21XVVB7QV20JSE4R7SR1AF`):
 * Bulk operations like "delete all 150 tags" used to hit the 4-turn
 * cap and the loop bailed silently — Mo "exited tools without a
 * message". With the chat prompt now capping destructive calls at
 * ~20 per turn, 8 turns covers 160 destructive ops without overflow,
 * which matches the user's worst-case batch size. Non-destructive
 * tool chains rarely exceed 2-3 turns in practice; this bump only
 * costs extra provider calls on the long-tail bulk-delete path.
 */
export const MAX_TOOL_TURNS = 8;

export const USER_ACTOR = 'user';

export function requireConciergeDeps(ctx: ToolContext):
  | { ok: true; bag: NonNullable<ToolContext['concierge']> }
  | { ok: false } {
  if (!ctx.concierge) return { ok: false };
  return { ok: true, bag: ctx.concierge };
}

/** Phase 6.8 — turn a free-form topic name into a slug that matches
 *  the backend's `ANCHORED_SECTION_RE` charset (`[a-z][a-z0-9_-]*`).
 *  Lowercases, replaces every non-alphanumeric run with a single
 *  hyphen, strips leading/trailing hyphens, drops a leading digit
 *  by prefixing `t-` (regex requires a leading letter). Returns
 *  empty string if nothing alphanumeric survives — caller surfaces
 *  the validation error. */
export function slugifyTopicName(raw: string): string {
  const lower = raw.trim().toLowerCase();
  let slug = lower
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return '';
  if (/^[0-9]/.test(slug)) slug = `t-${slug}`;
  return slug.slice(0, 80);
}

/**
 * Adapt the route's `ToolContext` to the `ConciergeDepsHost` interface
 * the shared deps factory expects. ToolContext.concierge is optional;
 * callers that reach this helper have already passed `requireConciergeDeps`,
 * so the cast to non-null is safe.
 */
export function asHost(ctx: ToolContext): ConciergeDepsHost {
  return {
    db: ctx.db,
    notes: ctx.notes,
    folders: ctx.folders,
    comments: ctx.comments,
    settings: ctx.settings,
    concierge: ctx.concierge!,
    // Phase 2 — passed through so HTTP-triggered indexing tick paths
    // (e.g. mo_patrol on demand) can write to mo_metadata_vec the same
    // way the scheduler does. Optional in ToolContext, optional here —
    // missing -> vec writes silently skipped.
    embeddings: ctx.embeddings,
  };
}
