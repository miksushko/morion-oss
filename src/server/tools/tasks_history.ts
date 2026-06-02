import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';

export const tasksHistoryTool = defineTool({
  name: 'tasks_history',
  description:
    'Read the kanban status history of a single note — every status_change audit row, newest first. Each entry carries ts (epoch-ms), actor (who moved it, e.g. user or mcp:<client>), statusFrom, statusTo. Pure read-only, no mutation. Use this to reconstruct "who moved this card when" — useful when investigating why a task is in an unexpected column or auditing an agent\'s workflow.',
  category: 'read',
  inputShape: {
    id: z.string().describe('Note id whose status history to read.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Max rows to return. Default 50, max 200.'),
  },
  async handler(input, ctx) {
    // Read-gate against the note itself so a hidden note's history
    // stays hidden too.
    if (!canPerform('read', ctx, { kind: 'note', noteId: input.id })) return ACCESS_DENIED;

    const existing = ctx.notes.getById(input.id, { includeTrashed: true });
    if (!existing) {
      return { error: 'note_not_found', message: `No note with id ${input.id}.` };
    }

    const history = ctx.audit.statusHistory(input.id, input.limit);
    return { noteId: input.id, history };
  },
});
