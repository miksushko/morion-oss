import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';
import { NOTE_STATUSES } from '../../core/notes/types.js';

/** Upper bound on the optional `message` param. Same magnitude as
 *  COMMENT_BODY_MAX (50k) but shorter because a status-change message
 *  should be a terse explanation, not a wall of text. */
const STATUS_CHANGE_MESSAGE_MAX = 10_000;

export const tasksMoveTool = defineTool({
  name: 'tasks_move',
  description:
    "Move a note into a different kanban column (and optionally position it within that column). Single tool for both 'change status' and 'reorder within column'. Does NOT bump updated_at — kanban placement is metadata, not content. Writes an audit_log row with status_from / status_to when the column changes (pure intra-column reorders write nothing). Use afterNoteId to insert the card right after a specific sibling; pass null (or omit) to place at the top of the column. Prefer this tool over notes_update for status changes so history is recorded. Optional `message` posts a comment on the note explaining the move (auto-visible in the activity feed); required when the `mcp.require_status_comment` setting is on.",
  category: 'update',
  // Reversible metadata flip. Status change is data-preserving — a kanban→list
  // toggle on the folder hides the value but doesn't destroy it.
  annotations: { destructiveHint: false },
  inputShape: {
    id: z.string().describe('Note id to move.'),
    status: z
      .enum(NOTE_STATUSES)
      .describe('Target column. One of: note, backlog, todo, doing, review, done.'),
    afterNoteId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Sibling to insert after. null or omitted = top of the column. Ignored when the target column is 'note' (chronological order).",
      ),
    message: z
      .string()
      .max(STATUS_CHANGE_MESSAGE_MAX)
      .optional()
      .describe(
        'Optional explanation for the move. When non-empty, auto-posts as a comment on the note ("Moved to {status}: {message}") in the same transaction as the status change. When `mcp.require_status_comment` is enabled AND the caller is an MCP actor, this field becomes REQUIRED (omit / empty returns `status_comment_required`).',
      ),
  },
  async handler(input, ctx) {
    if (!canPerform('update', ctx, { kind: 'note', noteId: input.id })) return ACCESS_DENIED;

    const existing = ctx.notes.getById(input.id);
    if (!existing) {
      return { error: 'note_not_found', message: `No note with id ${input.id}.` };
    }

    // Require the containing folder to be in kanban mode. list-folders have
    // latent statuses (stored but not shown). Letting an LLM mutate them
    // through tasks_move would silently reorder a UI the user never see.
    if (existing.folderId !== null) {
      const folder = ctx.folders.getById(existing.folderId);
      if (folder && folder.viewMode !== 'kanban') {
        return {
          error: 'folder_not_kanban',
          message: `Folder "${folder.name}" is in list mode. Use folders_set_view_mode to enable kanban, or use notes_update instead.`,
        };
      }
    }

    // Direction Q Phase Q4 — require message for MCP actors when the
    // setting is on. Checked dynamically per-call (not statically in
    // zod) so flipping the setting in SettingsPanel takes effect
    // immediately without re-registering the tool. User actor
    // ('user') is never required.
    const trimmedMessage = input.message?.trim() ?? '';
    const isMcp = ctx.actor.startsWith('mcp:');
    if (isMcp && ctx.settings.getRequireLlmStatusComment() && trimmedMessage === '') {
      return {
        error: 'status_comment_required',
        message:
          'A non-empty `message` is required when the host user has enabled "Require LLM to explain every kanban status change" in Morion settings. Describe why you are moving the card.',
      };
    }

    // Atomic move + optional auto-comment in a single tx so a crash
    // between them can't leave the board in the new state with no
    // explanation on record.
    return ctx.db.transaction(() => {
      const moved = ctx.notes.moveToKanban(
        input.id,
        input.status,
        input.afterNoteId ?? null,
        ctx.actor,
      );
      if (trimmedMessage !== '') {
        const body = `Moved to ${input.status}: ${trimmedMessage}`;
        ctx.comments.create(input.id, body, ctx.actor, null);
      }
      return moved;
    })();
  },
});
