import { z } from 'zod';
import { defineTool } from './types.js';
import {
  canEditComment,
  MCP_COMMENTS_DISABLED,
  COMMENT_ACTOR_MISMATCH,
} from '../../core/permissions/comments.js';
import {
  COMMENT_BODY_MAX,
  CommentActorMismatchError,
} from '../../core/notes/comments-types.js';

/**
 * Edit the body of a comment you posted.
 *
 * Gate precedence (see `canEditComment`):
 *   1. Actor match — an MCP client can only edit its OWN comments. You
 *      cannot rewrite a human's Slack-style note, and one agent cannot
 *      rewrite another's.
 *   2. `mcp_comments_editable` setting — when false, MCP edit is
 *      disabled entirely even for own comments. User's belt-and-braces
 *      lockdown from SettingsPanel.
 *   3. Host note's `update` permission (Pro-tier gate).
 *
 * Stamps `updated_at = now()`. No audit_log row — the comment's own
 * `updated_at` is the evidence.
 */
export const notesUpdateCommentTool = defineTool({
  name: 'notes_update_comment',
  description:
    'Edit the body of a comment you authored. Only works on comments with your own actor. Throws `comment_actor_mismatch` when attempting to edit another actor\'s comment. If the user has disabled MCP comment edits in settings, returns `mcp_comments_disabled`.',
  category: 'update',
  annotations: { destructiveHint: false },
  inputShape: {
    commentId: z.string().describe('The ulid of the comment to edit.'),
    body: z
      .string()
      .min(1)
      .max(COMMENT_BODY_MAX)
      .describe(`New markdown body. Max ${COMMENT_BODY_MAX} characters.`),
  },
  async handler(input, ctx) {
    const existing = ctx.comments.getById(input.commentId);
    if (!existing) return { error: 'comment_not_found' };

    const decision = canEditComment(existing, ctx);
    if (!decision.ok) {
      if (decision.reason === 'actor_mismatch') return COMMENT_ACTOR_MISMATCH;
      if (decision.reason === 'mcp_disabled') return MCP_COMMENTS_DISABLED;
      return { error: 'mcp_access_denied' };
    }

    try {
      const updated = ctx.comments.update(input.commentId, input.body, ctx.actor);
      if (!updated) return { error: 'comment_not_found' };
      return updated;
    } catch (err) {
      // canEditComment already matched, so this is strictly defense-in-depth.
      if (err instanceof CommentActorMismatchError) {
        return COMMENT_ACTOR_MISMATCH;
      }
      throw err;
    }
  },
});
