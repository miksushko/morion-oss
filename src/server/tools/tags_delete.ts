import { z } from 'zod';
import { defineTool } from './types.js';

export const tagsDeleteTool = defineTool({
  name: 'tags_delete',
  description:
    'Delete a tag by id. Notes that carried this tag stay — only the note↔tag link is removed via ON DELETE CASCADE on note_tags. Returns { ok: true } on success, { ok: false } if the id was not found.',
  category: 'delete',
  inputShape: {
    id: z.string().describe('Tag id'),
  },
  async handler(input, ctx) {
    const ok = ctx.tags.delete(input.id);
    return { ok };
  },
});
