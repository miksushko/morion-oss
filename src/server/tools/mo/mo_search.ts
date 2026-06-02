import { z } from 'zod';
import { defineTool } from '../types.js';
import { canPerform, ACCESS_DENIED } from '../../../core/permissions/check.js';
import { toMoInternalCtx } from '../../../core/concierge/index.js';
import {
  requireMoEnabledForFolder,
} from './gate.js';

/**
 * Mo Indexing Redesign Phase 5b — `mo_search` MCP tool.
 *
 * Hybrid FTS + vector search routed via mo:catalog. Returns a list
 * of note hits (id + title + snippet + score + cluster ids). NOT
 * a synthesized answer — that's `mo_ask`'s job.
 *
 * Cluster filter: the caller can pre-route via `cluster` (string or
 * array) — typically obtained from `mo_list_clusters` first. When
 * unscoped, the search runs across the whole folder.
 *
 * Cheaper than `mo_ask` — no sub-Mo extraction, no synthesis. Use
 * this when you want a list of relevant ULIDs (e.g. "find tickets
 * about gpt-5 reasoning models") and you'll fetch / read them
 * yourself.
 *
 * CLAUDE.md invariant: indices augment search, never replace it.
 * `mo_list_clusters` returns the cluster directory (router);
 * `mo_search` does the live retrieval; details in the final answer
 * cite the actual notes, not the catalog body.
 */
export const moSearchTool = defineTool({
  name: 'mo_search',
  category: 'read',
  description:
    "Hybrid FTS + vector search routed through mo:catalog clusters. Returns a list of note hits enriched by default with `summary` + `keywords` + `clusters` from Mo's per-note index, so an agent can decide which bodies to actually open without follow-up reads. NOT a synthesized answer — use mo_ask for that. Optionally pre-filtered to specific cluster ids. Cheaper than mo_ask: no sub-Mo extraction, no LLM synthesis. Requires the folder to have Mo enabled when folderId is set.",
  inputShape: {
    query: z
      .string()
      .min(1)
      .describe(
        'The search query. Plain keywords or a phrase. Hybrid retrieval combines FTS5 BM25 with vector cosine.',
      ),
    folderId: z
      .string()
      .optional()
      .describe(
        'Optional Morion folder id to scope the search. The folder must have Mo enabled. Unscoped searches span every Mo-readable note.',
      ),
    cluster: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        'Optional cluster filter — one cluster id or a list. A note matches if at least one of its note_mo_clusters assignments is in the list (many-to-many). Empty array = zero hits.',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe('Max hits returned. Default 10, max 50.'),
    withMetadata: z
      .boolean()
      .optional()
      .describe(
        "Include Mo-generated `summary` + `keywords` per hit. Default true (Mo's whole point is metadata-first candidate filtering); set to false only if you genuinely just need the ranked id list and are about to drop the heavier fields.",
      ),
  },
  async handler(input, ctx) {

    if (input.folderId !== undefined) {
      const moGate = requireMoEnabledForFolder(ctx, input.folderId);
      if (moGate) return moGate;
      if (!canPerform('read', ctx, { kind: 'folder', folderId: input.folderId })) {
        return ACCESS_DENIED;
      }
    }

    const limit = input.limit ?? 10;
    const withMetadata = input.withMetadata ?? true;

    // Phase 3 — Mo is owner-level, not a third-party MCP client.
    // Internal search runs WITH archived included + an elevated actor
    // for the per-note permission post-filter, so an `mcp:claude-code`
    // caller still sees archived material that Mo finds relevant. The
    // user's exclusion path is per-folder Mo enablement, NOT archiving.
    // Outer gates (folder Mo-enabled, folder MCP-read perm
    // for the ORIGINAL caller) ran above before any work happened.
    const moCtx = toMoInternalCtx(ctx);
    const hits = await ctx.search.search(input.query, {
      limit,
      folderId: input.folderId,
      cluster: input.cluster,
      includeArchived: true,
    });

    // Post-filter through canPerform per note — same defence-in-depth
    // every read tool runs after the SQL filter. Cluster filter already
    // ran inside HybridSearch.applyFilters; the elevated `moCtx`
    // bypasses the archive gate (Mo is non-MCP per `morion-concierge`
    // actor), so archived notes survive into the response.
    const visible = hits.filter((hit) =>
      canPerform('read', moCtx, { kind: 'note', noteId: hit.note.id }),
    );

    // Batch-resolve cluster assignments + (optional) per-note metadata
    // in two SELECT IN queries instead of N+1 loops. `moClusters` /
    // `moMetadata` are optional in the concierge bag for test fixtures
    // that build a slim context — degrade silently to empty / null.
    const noteIds = visible.map((h) => h.note.id);
    const clustersByNoteId =
      ctx.concierge?.moClusters?.listClusterIdsForNotes(noteIds) ?? new Map();
    const metaByNoteId = withMetadata
      ? ctx.concierge?.moMetadata?.getMany(noteIds) ?? null
      : null;

    const items = visible.map((hit) => {
      const meta = metaByNoteId?.get(hit.note.id) ?? null;
      const base = {
        noteId: hit.note.id,
        title: hit.note.title,
        snippet: hit.snippet,
        score: hit.score,
        folderId: hit.note.folderId,
        clusters: clustersByNoteId.get(hit.note.id) ?? [],
        updatedAt: hit.note.updatedAt,
      };
      if (!withMetadata) return base;
      return {
        ...base,
        summary: meta?.summary ?? null,
        keywords: meta?.keywords ?? null,
      };
    });

    return {
      query: input.query,
      requestedClusters: input.cluster
        ? Array.isArray(input.cluster)
          ? input.cluster
          : [input.cluster]
        : null,
      hits: items,
      totalReturned: items.length,
      hint:
        items.length === 0
          ? 'No hits. Try mo_list_clusters to see which clusters exist in this folder, or drop the cluster filter.'
          : null,
    };
  },
});
