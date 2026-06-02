import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';

export const notesMoveTool = defineTool({
  name: 'notes_move',
  description:
    'Move a note into a different folder. Pass null as folderId to unfile the note (root). Folder moves are organisational metadata: they do NOT bump updated_at, so the moved note keeps its position in the date-sorted list. Returns the updated note, or null if it does not exist.',
  category: 'update',
  // Just flips `folder_id` on the note row. Body + title untouched,
  // reversible.
  annotations: { destructiveHint: false },
  inputShape: {
    id: z.string().describe('Note id to move'),
    folderId: z
      .string()
      .nullable()
      .describe('Destination folder id, or null to unfile the note (place it at the root).'),
  },
  async handler(input, ctx) {
    // Source must be updatable; destination must accept new notes (create).
    // Otherwise an LLM could shuffle a write-protected note into a folder
    // it could mutate freely.
    if (!canPerform('update', ctx, { kind: 'note', noteId: input.id })) return ACCESS_DENIED;
    if (!canPerform('create', ctx, { kind: 'newNote', folderId: input.folderId })) return ACCESS_DENIED;
    return ctx.notes.update(input.id, { folderId: input.folderId }, ctx.actor);
  },
});
