import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';
import { deleteFolderWithNotes } from '../features/folder-delete.js';

export const foldersDeleteTool = defineTool({
  name: 'folders_delete',
  description:
    'Delete a folder by id. By default the notes inside are moved to Trash with it (soft-delete, recoverable). Pass keepNotes:true to instead leave them as unfiled notes (folderId becomes null). mo:* system notes are always removed. Returns { ok, trashedNoteCount }.',
  category: 'delete',
  inputShape: {
    id: z.string().describe('Folder id'),
    keepNotes: z
      .boolean()
      .optional()
      .describe(
        'When true, notes inside are preserved as unfiled (folderId → null) instead of being moved to Trash. Default false — notes go to Trash with the folder.',
      ),
  },
  async handler(input, ctx) {
    if (!canPerform('delete', ctx, { kind: 'folder', folderId: input.id })) {
      return ACCESS_DENIED;
    }
    const { ok, trashedNoteCount } = deleteFolderWithNotes(ctx, input.id, {
      keepNotes: input.keepNotes === true,
    });
    return { ok, trashedNoteCount };
  },
});
