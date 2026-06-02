import type { NoteComment } from '../notes/comments-types.js';
import type { ToolContext } from '../../server/tools/types.js';
import { canPerform } from './check.js';

/**
 * Comment edit/delete gate. Called by HTTP PATCH/DELETE routes AND by
 * the MCP `notes_update_comment` / `notes_delete_comment` tools so both
 * surfaces share the same rule.
 *
 * Gate precedence (fail-fast, cheapest first):
 *   1. Actor match — `comment.actor === ctx.actor`. An MCP client can
 *      only edit comments it authored itself. The UI's `actor='user'`
 *      correspondingly only touches 'user' comments. Closes the class
 *      of "rogue MCP server rewrites my Slack message" attacks.
 *   2. Settings kill-switch `mcp_comments_editable` — only applies to
 *      MCP actors. When false, MCP can't edit/delete even its OWN
 *      posts; UI is unaffected (user's belt-and-braces lockdown).
 *   3. Permission engine `canPerform('update', note)` — Pro-tier
 *      per-folder/per-note overrides. Free tier short-circuits true.
 *
 * Returns a discriminated union rather than throwing because routes
 * want to translate the reason into different HTTP status codes
 * (403 for actor mismatch, 403 for mcp_disabled, 403 for
 * access_denied) and MCP tools wrap it into structured error
 * envelopes consumed by the LLM.
 */
export type CommentEditDecision =
  | { ok: true }
  | { ok: false; reason: 'actor_mismatch' | 'mcp_disabled' | 'access_denied' };

export function canEditComment(
  comment: NoteComment,
  ctx: ToolContext,
): CommentEditDecision {
  // 1. Actor must match. Trivial check, catches the "rewrite my post"
  //    attack without any repo lookup.
  if (comment.actor !== ctx.actor) {
    return { ok: false, reason: 'actor_mismatch' };
  }

  // 2. Settings kill-switch. Scope: MCP actors only. `actor='user'`
  //    bypasses — the user always retains UI ownership of their own
  //    comments regardless of how they've locked down MCP.
  if (ctx.actor.startsWith('mcp:') && !ctx.settings.getMcpCommentsEditable()) {
    return { ok: false, reason: 'mcp_disabled' };
  }

  // 3. Pro-tier per-folder/per-note update gate. Comment mutation is
  //    scoped to the host note's update permission (commenting on a
  //    read-only note is not a bypass).
  if (!canPerform('update', ctx, { kind: 'note', noteId: comment.noteId })) {
    return { ok: false, reason: 'access_denied' };
  }

  return { ok: true };
}

/** Stable error envelope for the 'mcp_disabled' branch — shared by
 *  the route and the MCP tool so clients see identical wire shape. */
export const MCP_COMMENTS_DISABLED = {
  error: 'mcp_comments_disabled',
  message:
    'MCP edit/delete of comments is disabled in Morion settings. Your MCP client cannot modify comments until the setting is flipped back on.',
} as const;

/** Stable error envelope for the 'actor_mismatch' branch. */
export const COMMENT_ACTOR_MISMATCH = {
  error: 'comment_actor_mismatch',
  message:
    'You can only edit or delete comments that you posted yourself. This comment was authored by a different actor.',
} as const;
