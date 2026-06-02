import { z } from 'zod';
import { defineTool } from './types.js';
import {
  canEditComment,
  MCP_COMMENTS_DISABLED,
  COMMENT_ACTOR_MISMATCH,
} from '../../core/permissions/comments.js';
import { CommentActorMismatchError } from '../../core/notes/comments-types.js';

/**
 * Delete a comment you authored. Cascades to its replies via the FK.
 *
 * Gate precedence matches `notes_update_comment`: actor-match first,
 * then settings kill-switch, then Pro-tier note update permission.
 *
 * Writes a `comment_delete` audit_log tombstone in the SAME transaction
 * as the row delete. That's the only comment-lifecycle audit row we
 * emit — create/update are evidenced by the comment row itself.
 */
export const notesDeleteCommentTool = defineTool({
  name: 'notes_delete_comment',
  description:
    'Delete a comment you authored. Cascades to the comment\'s replies via DB foreign key. Writes an audit-log `comment_delete` tombstone so the activity feed reflects the deletion. Same actor-match + settings kill-switch + note-update gate as `notes_update_comment`.',
  category: 'delete',
  annotations: { destructiveHint: true },
  inputShape: {
    commentId: z.string().describe('The ulid of the comment to delete.'),
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
      const tx = ctx.db.transaction(() => {
        ctx.comments.delete(input.commentId, ctx.actor);
        ctx.audit.record({
          noteId: existing.noteId,
          action: 'comment_delete',
          actor: ctx.actor,
        });
      });
      tx();
      return { ok: true, deletedCommentId: input.commentId, noteId: existing.noteId };
    } catch (err) {
      if (err instanceof CommentActorMismatchError) {
        return COMMENT_ACTOR_MISMATCH;
      }
      throw err;
    }
  },
});
