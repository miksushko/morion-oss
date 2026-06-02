import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';

export const notesGetTool = defineTool({
  name: 'notes_get',
  description:
    'Fetch a single note by id, including its full body and tags. Returns null if the note does not exist or was deleted. Returns an ACCESS_DENIED envelope if the note is archived (archived = user has hidden it from MCP) or gated by Pro permissions.',
  category: 'read',
  inputShape: {
    id: z.string().describe('The ulid returned by notes_create or notes_search.'),
  },
  async handler(input, ctx) {
    // canPerform covers both Pro permissions AND the archive gate
    // (MCP-caller only) — archived notes / notes in archived folders
    // return false so this tool never reveals them.
    if (!canPerform('read', ctx, { kind: 'note', noteId: input.id })) return ACCESS_DENIED;
    return ctx.notes.getById(input.id, { audit: true, actor: ctx.actor });
  },
});
