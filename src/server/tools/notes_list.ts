import { z } from 'zod';
import { defineTool } from './types.js';
import { filterReadable } from '../../core/permissions/check.js';

export const notesListTool = defineTool({
  name: 'notes_list',
  description:
    'List notes ordered by pinned first, then most-recently-updated. Supports folder/tag/pinned filters and pagination. Use this to browse when you do not have a keyword to search for. Pass `withMetadata: true` to enrich each note with Mo-generated `summary` + `keywords` (null on un-indexed notes) so an agent can scan candidates without opening every body.',
  category: 'read',
  inputShape: {
    folderId: z.string().nullable().optional(),
    tag: z.string().optional(),
    pinned: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).default(50),
    offset: z.number().int().min(0).default(0),
    withMetadata: z
      .boolean()
      .optional()
      .describe(
        "Include Mo-generated `summary` + `keywords` per note (null when Tier 1 hasn't indexed yet). Default false to keep the slim shape that legacy callers expect.",
      ),
  },
  async handler(input, ctx) {
    const all = ctx.notes.list({
      folderId: input.folderId,
      tag: input.tag,
      pinned: input.pinned,
      limit: input.limit,
      offset: input.offset,
    });
    const visible = filterReadable(all, ctx);
    if (!input.withMetadata) return visible;

    // Batch metadata lookup: one SELECT IN over the visible page.
    // `moMetadata` repo may be absent in test fixtures — degrade silently
    // to null fields rather than 500'ing on a perfectly valid list call.
    const metaByNoteId =
      ctx.concierge?.moMetadata?.getMany(visible.map((n) => n.id)) ?? null;
    return visible.map((n) => {
      const meta = metaByNoteId?.get(n.id) ?? null;
      return {
        ...n,
        summary: meta?.summary ?? null,
        keywords: meta?.keywords ?? null,
      };
    });
  },
});
