import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform } from '../../core/permissions/check.js';

export const notesSearchTool = defineTool({
  name: 'notes_search',
  description:
    'Keyword + semantic hybrid search over all notes. Returns ranked hits with a highlighted snippet. If the first query returns nothing useful, try alternative wordings — the index uses BM25 plus an optional vector store, so synonyms and different phrasings help. Pass `withMetadata: true` to enrich each hit with Mo-generated `summary` + `keywords` (when available) so an agent can decide which bodies to actually open without a follow-up read.',
  category: 'read',
  inputShape: {
    query: z.string().min(1).describe('Free-form search query. Multiple words are ranked together.'),
    folderId: z.string().nullable().optional(),
    tag: z.string().optional(),
    createdAfter: z.number().int().nonnegative().optional().describe('Filter to notes created at or after this ms-epoch timestamp.'),
    createdBefore: z.number().int().nonnegative().optional().describe('Filter to notes created at or before this ms-epoch timestamp.'),
    updatedAfter: z.number().int().nonnegative().optional().describe('Filter to notes updated at or after this ms-epoch timestamp.'),
    updatedBefore: z.number().int().nonnegative().optional().describe('Filter to notes updated at or before this ms-epoch timestamp.'),
    limit: z.number().int().min(1).max(50).default(10),
    withMetadata: z
      .boolean()
      .optional()
      .describe(
        "Include Mo-generated `summary` (one-paragraph) + `keywords` (string[]) per hit. Both are null on notes Tier 1 hasn't indexed yet. Default false to preserve the slim hit shape; flip on for cheap candidate filtering before opening bodies.",
      ),
  },
  async handler(input, ctx) {
    // `includeArchived` deliberately not exposed: the MCP archive
    // privacy gate (`isNoteMcpHidden` in `canPerform`) hides archived
    // notes from MCP callers regardless of search options, by product
    // design. Surfacing the flag would be dead code; users who want
    // archived content unarchive in the UI or use "Share with LLM"
    // on a specific note.
    const hits = await ctx.search.search(input.query, {
      limit: input.limit,
      folderId: input.folderId,
      tag: input.tag,
      createdAfter: input.createdAfter,
      createdBefore: input.createdBefore,
      updatedAfter: input.updatedAfter,
      updatedBefore: input.updatedBefore,
    });
    // Post-filter denied notes silently — never surface a snippet for a
    // note the LLM doesn't have permission to read. The MCP client
    // doesn't even learn the note exists.
    const visible = hits.filter((h) =>
      canPerform('read', ctx, { kind: 'note', noteId: h.note.id }),
    );

    // Batch-resolve Mo metadata when requested. One SELECT IN, no N+1.
    // `moMetadata` is optional in the concierge bag (test fixtures may
    // skip it) — silently degrade to null fields if absent.
    const metaByNoteId = input.withMetadata
      ? ctx.concierge?.moMetadata?.getMany(visible.map((h) => h.note.id)) ?? null
      : null;

    return visible.map((h) => {
      const base = {
        id: h.note.id,
        title: h.note.title,
        snippet: h.snippet,
        score: h.score,
        folderId: h.note.folderId,
        tags: h.note.tags,
        updatedAt: h.note.updatedAt,
      };
      if (!input.withMetadata) return base;
      const meta = metaByNoteId?.get(h.note.id) ?? null;
      return {
        ...base,
        summary: meta?.summary ?? null,
        keywords: meta?.keywords ?? null,
      };
    });
  },
});
