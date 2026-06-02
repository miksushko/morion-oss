import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';
import {
  COMMENT_BODY_MAX,
  NestedReplyError,
} from '../../core/notes/comments-types.js';

/**
 * Post a comment on a note (or a 1-level reply to an existing top-level
 * comment). Actor comes from the MCP client identity (`mcp:<client>`),
 * NOT a field in the input — agents can't impersonate each other.
 *
 * Gated against the host note's `update` permission (commenting mutates
 * the note's conversation surface).
 */
export const notesAddCommentTool = defineTool({
  name: 'notes_add_comment',
  description:
    'Post a comment on a note, or a reply to an existing top-level comment. `parentId` is optional (omit for a top-level comment). Only 1 level of nesting is allowed — replying to a reply returns an error. Body supports markdown + morion://attachment/<id> image refs.',
  category: 'create',
  inputShape: {
    noteId: z.string().describe('The ulid of the note to comment on.'),
    body: z
      .string()
      .min(1)
      .max(COMMENT_BODY_MAX)
      .describe(
        `Markdown body. Max ${COMMENT_BODY_MAX} characters. Supports inline images via \`![alt](morion://attachment/<ulid>)\` — upload attachments via POST /api/attachments first (Direction P).`,
      ),
    parentId: z
      .string()
      .optional()
      .describe(
        'Optional ulid of a top-level comment to reply to. Must belong to the same note. Must itself be top-level (no reply-to-replies).',
      ),
  },
  async handler(input, ctx) {
    const note = ctx.notes.getById(input.noteId);
    if (!note) return { error: 'note_not_found' };
    if (!canPerform('update', ctx, { kind: 'note', noteId: input.noteId })) {
      return ACCESS_DENIED;
    }
    try {
      const comment = ctx.comments.create(
        input.noteId,
        input.body,
        ctx.actor,
        input.parentId ?? null,
      );
      if (!comment) {
        // Either the note disappeared between the getById check and the
        // insert tx (race) or parentId refers to a comment on a
        // different note / a missing row.
        return { error: 'invalid_parent_or_note' };
      }
      return comment;
    } catch (err) {
      if (err instanceof NestedReplyError) {
        return { error: 'nested_reply_rejected', message: err.message };
      }
      throw err;
    }
  },
});
