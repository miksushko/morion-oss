import type { ToolContext } from '../../server/tools/types.js';
import { CONCIERGE_ACTOR } from './types.js';

/**
 * Phase 3 — context restructure ticket `01KQFQ1RJV7EH0X3WF2H1A476J`.
 *
 * Elevate a MCP-caller `ToolContext` (`mcp:claude-code` /
 * `mcp:codex` / etc.) to Mo's owner-level actor before performing
 * internal context-gather work. Mo is conceptually the user's own
 * assistant — not a third-party MCP client — so its sub-Mo orchestrator,
 * search, and metadata reads need owner perms. That includes seeing
 * archived notes / folders and notes in archived folders, all of which
 * are hidden from regular `mcp:*` actors by `canPerform` /
 * `isNoteMcpHidden` (per CLAUDE.md "Archive privacy is a runtime gate").
 *
 * Why a helper instead of inlining `{...ctx, actor: MO_ACTOR}`:
 *   - One spot to find every elevation site for audit (grep).
 *   - One spot to add future fields (e.g. a `viaMcp: 'claude-code'`
 *     trace field for the audit log) without touching every call site.
 *   - Mirror the pattern already in `routes/concierge.ts` (chat tool-
 *     dispatch) — same shape, single canonical name.
 *
 * **Use only inside `mo_*` MCP tool handlers + sub-Mo orchestration.**
 * Do NOT elevate inside `notes_*` / `folders_*` / `tasks_*` MCP tools —
 * those gate per the calling actor by design (the user expects
 * `mcp:claude-code` to NOT see archived material via `notes_search`,
 * only via `mo_search` / `mo_get_context` where Mo is mediating).
 *
 * The user controls Mo exclusion at folder level via
 * `concierge_folder_settings.enabled = false` — putting a folder in
 * the "no Mo" bucket is the right path to keep something out of Mo's
 * reach, NOT archiving.
 */
export function toMoInternalCtx(ctx: ToolContext): ToolContext {
  // Object spread preserves every field Mo's downstream might need
  // (db handle, repos, search, settings, concierge bag, embeddings).
  // Only `actor` flips. If ctx.actor is already `morion-concierge`
  // (Mo calling itself, e.g. scheduler tick), the no-op spread keeps
  // it valid — no defensive branch needed.
  return { ...ctx, actor: CONCIERGE_ACTOR };
}
