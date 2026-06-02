import { z } from 'zod';
import { defineTool } from './types.js';
import { duplicateFolder } from '../../core/folders/duplicate.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';

export const foldersDuplicateTool = defineTool({
  name: 'folders_duplicate',
  description:
    'Duplicate a folder. Creates a clone with the "(Copy)" suffix inserted right after the source in the sidebar order, then deep-copies every non-deleted note inside it (new note ids, fresh timestamps). Returns the new folder. Returns null if the source folder does not exist.',
  category: 'create',
  inputShape: {
    id: z.string().min(1).describe('Folder id to duplicate'),
  },
  async handler(input, ctx) {
    // The clone would expose every note inside a hidden folder (the new
    // folder has no permission overrides set), so require read access to
    // the source before deep-copying it.
    if (!canPerform('read', ctx, { kind: 'folder', folderId: input.id })) {
      return ACCESS_DENIED;
    }
    const result = duplicateFolder(ctx.folders, ctx.notes, input.id, ctx.actor);
    if (!result) return null;
    for (const noteId of result.newNoteIds) {
      const note = ctx.notes.getById(noteId);
      if (note) await ctx.indexer.reindex(note);
    }
    return result.folder;
  },
});
