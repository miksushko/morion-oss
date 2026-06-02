import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';

export const tasksClaimTool = defineTool({
  name: 'tasks_claim',
  description:
    "Atomically take ownership of a todo task by flipping its status from 'todo' to 'doing'. The race-condition guard when two agents read the same tasks_list and try to pick the top card: exactly one claim call succeeds, others return {claimed: false}. Use this before starting work on a task. If claimed=false, the task was already taken — re-read tasks_list and pick another. Writes an audit row so tasks_history shows who claimed when. Does NOT bump updated_at.",
  category: 'update',
  // Reversible status flip — tasks_move can put it back.
  annotations: { destructiveHint: false },
  inputShape: {
    id: z.string().describe('Note id of the task to claim. Must currently be in status=todo.'),
  },
  async handler(input, ctx) {
    if (!canPerform('update', ctx, { kind: 'note', noteId: input.id })) return ACCESS_DENIED;

    const existing = ctx.notes.getById(input.id);
    if (!existing) {
      return { error: 'note_not_found', message: `No note with id ${input.id}.` };
    }

    // Same guard as tasks_move: claim only makes sense in kanban context.
    if (existing.folderId !== null) {
      const folder = ctx.folders.getById(existing.folderId);
      if (folder && folder.viewMode !== 'kanban') {
        return {
          error: 'folder_not_kanban',
          message: `Folder "${folder.name}" is in list mode. tasks_claim only applies to kanban-folders.`,
        };
      }
    }

    const result = ctx.notes.claimTask(input.id, ctx.actor);
    return {
      claimed: result.claimed,
      note: result.note,
      // Surface the current status so an LLM that lost the race can decide
      // whether to retry on a different task or wait.
      currentStatus: result.note?.status ?? null,
    };
  },
});
