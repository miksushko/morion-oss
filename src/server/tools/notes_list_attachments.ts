import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';

/**
 * List every attachment row for a given note, WITHOUT the bytes.
 *
 * The companion to `notes_get_attachment`: call this first, then
 * decide which (if any) image is worth pulling the bytes for. Each
 * entry is tiny (~30 tokens) — lets the LLM see "this note has 3
 * PNGs, one 1920×1080, one 64×64 icon" and pick targets without
 * blowing the context budget on images it doesn't need.
 *
 * Readable-permission gate is on the owning note: if the caller can
 * read the note, it can see the list of attachments. No per-
 * attachment ACLs.
 */
export const notesListAttachmentsTool = defineTool({
  name: 'notes_list_attachments',
  description:
    'List attachment metadata (id, alt, mime, size, dimensions) for a note. Use this to preview what images are attached before calling notes_get_attachment to fetch actual bytes.',
  category: 'read',
  inputShape: {
    noteId: z
      .string()
      .describe('The ulid of the note whose attachments you want to enumerate.'),
  },
  async handler(input, ctx) {
    const note = ctx.notes.getById(input.noteId);
    if (!note) return { error: 'note_not_found' };
    if (!canPerform('read', ctx, { kind: 'note', noteId: input.noteId })) {
      return ACCESS_DENIED;
    }
    const attachments = ctx.attachments.listByNoteId(input.noteId);
    return {
      noteId: input.noteId,
      attachments: attachments.map((a) => ({
        id: a.id,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        width: a.width,
        height: a.height,
        // Wire URL the LLM can feed back into notes_get_attachment or
        // reference in note bodies. Matches `formatNoteShare`'s
        // reference-only ethos.
        url: `morion://attachment/${a.id}`,
        createdAt: a.createdAt,
      })),
    };
  },
});
