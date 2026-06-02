import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';

export const notesAppendTool = defineTool({
  name: 'notes_append',
  description:
    'Append text to an existing note body without rewriting it. Avoids the read-modify-write round-trip of notes_get + notes_update. The default separator is two newlines (markdown paragraph break). Returns the updated note, or null if it does not exist.',
  category: 'create',
  // Appending text to an existing note body IS a mutation of live content,
  // even though we classify it as `create` for the per-category MCP gate.
  annotations: { destructiveHint: true },
  inputShape: {
    id: z.string().describe('Note id to append to'),
    text: z.string().min(1).describe('Markdown text to append'),
    separator: z
      .string()
      .optional()
      .describe('String inserted between the existing body and the new text. Default "\\n\\n".'),
  },
  async handler(input, ctx) {
    // Append is semantically an update — gate on note's `update` permission,
    // not `create` despite the tool living in the create category.
    if (!canPerform('update', ctx, { kind: 'note', noteId: input.id })) return ACCESS_DENIED;
    const existing = ctx.notes.getById(input.id);
    if (!existing) return null;

    // Snapshot the pre-append state so a Restore can undo the LLM write.
    // Same dedup behaviour as notes_update — see the comment there. Both
    // operations run in a single outer transaction (audit N12, 2026-04-16)
    // so a crash between them can't orphan a revision.
    const separator = input.separator ?? '\n\n';
    const newBody =
      existing.body.length === 0 ? input.text : `${existing.body}${separator}${input.text}`;

    const updated = ctx.db.transaction(() => {
      ctx.revisions.create(input.id, ctx.actor);
      return ctx.notes.update(input.id, { body: newBody }, ctx.actor);
    })();
    if (updated) await ctx.indexer.reindex(updated);
    return updated;
  },
});
