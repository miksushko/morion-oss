import { z } from 'zod';
import { defineTool } from './types.js';
import { filterReadable } from '../../core/permissions/check.js';

export const notesRecentTool = defineTool({
  name: 'notes_recent',
  description:
    'Last N notes by updated_at desc. Pin-agnostic — unlike notes_list which puts pinned notes first. Use this to answer "what was I working on yesterday?" without inventing a search query.',
  category: 'read',
  inputShape: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of notes to return. Default 10, max 100.'),
  },
  async handler(input, ctx) {
    return filterReadable(ctx.notes.recent(input.limit ?? 10), ctx);
  },
});
