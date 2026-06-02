import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';
import {
  decodeActivityCursor,
  encodeActivityCursor,
} from '../../core/notes/comments-types.js';
import {
  countActivityForNote,
  listActivityForNote,
} from '../../core/activity/feed.js';

/**
 * Unified activity feed for a note: events (`create` / `update` / `delete`
 * / `status_change` / `comment_delete`) UNION'd with comments + replies.
 *
 * Token economy: default `limit=10` (not 20 like the HTTP route) because
 * an agent just getting the lay of the land needs «what's the last few
 * things that happened». If it needs deeper history, it paginates via
 * `cursor` — cheaper than returning 50 rows of audit text the agent
 * never uses.
 */
export const notesListActivityTool = defineTool({
  name: 'notes_list_activity',
  description:
    'Read the unified activity feed for a note: system events (create/update/delete/status_change/comment_delete) merged with comments + replies, newest first. Default returns 10 most-recent rows; use `cursor` from the previous response to paginate older pages.',
  category: 'read',
  inputShape: {
    noteId: z.string().describe('The ulid of the note to read activity for.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Page size. Default 10, max 200. Keep small — activity rows include full comment bodies.'),
    cursor: z
      .string()
      .optional()
      .describe(
        'Cursor from the previous response\'s `nextCursor` field. Omit on the first call; pass verbatim to fetch the next older page.',
      ),
  },
  async handler(input, ctx) {
    const note = ctx.notes.getById(input.noteId);
    if (!note) return { error: 'note_not_found' };
    if (!canPerform('read', ctx, { kind: 'note', noteId: input.noteId })) {
      return ACCESS_DENIED;
    }
    const before = input.cursor ? decodeActivityCursor(input.cursor) ?? undefined : undefined;
    const page = listActivityForNote(ctx.db, input.noteId, {
      limit: input.limit ?? 10,
      before,
    });
    const total = countActivityForNote(ctx.db, input.noteId);
    return {
      noteId: input.noteId,
      items: page.items,
      nextCursor: page.nextCursor ? encodeActivityCursor(page.nextCursor) : null,
      total,
    };
  },
});
