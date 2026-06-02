import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';

export const notesDuplicateTool = defineTool({
  name: 'notes_duplicate',
  description:
    'Clone a note by id. The new note has a fresh ULID and timestamps but copies the title, body, folder, tags, and pinned flag. Useful for templates. Returns the new note, or null if the source does not exist.',
  category: 'create',
  inputShape: {
    id: z.string().describe('Note id to duplicate'),
  },
  async handler(input, ctx) {
    // Read source + create in destination — both gates apply.
    if (!canPerform('read', ctx, { kind: 'note', noteId: input.id })) return ACCESS_DENIED;
    const source = ctx.notes.getById(input.id);
    if (!source) return null;
    if (!canPerform('create', ctx, { kind: 'newNote', folderId: source.folderId })) return ACCESS_DENIED;

    const created = ctx.notes.create(
      {
        body: source.body,
        folderId: source.folderId,
        tags: source.tags,
        pinned: source.pinned,
        source: ctx.actor.startsWith('mcp:') ? ctx.actor : 'user',
      },
      ctx.actor,
    );
    await ctx.indexer.reindex(created);
    return created;
  },
});
