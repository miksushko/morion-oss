import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';

export const notesDeleteTool = defineTool({
  name: 'notes_delete',
  description: 'Soft-delete a note by id. The note stays in the database with a deleted_at timestamp but disappears from list and search. Returns true on success.',
  category: 'delete',
  inputShape: {
    id: z.string(),
  },
  async handler(input, ctx) {
    if (!canPerform('delete', ctx, { kind: 'note', noteId: input.id })) return ACCESS_DENIED;
    const ok = ctx.notes.delete(input.id, ctx.actor);
    if (ok) ctx.indexer.remove(input.id);
    return { ok };
  },
});
