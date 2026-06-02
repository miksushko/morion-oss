import { z } from 'zod';
import { defineTool } from '../types.js';
import { canPerform, ACCESS_DENIED } from '../../../core/permissions/check.js';
import {
  requireMoEnabledForFolder,
} from './gate.js';
import { toMoInternalCtx } from '../../../core/concierge/index.js';

/**
 * Phase 6 primitive — context restructure ticket
 * `01KQFQ1RJV7EH0X3WF2H1A476J`.
 *
 * Bulk metadata listing for tasks/notes. Returns id + title + summary
 * + keywords + cluster ids + status — NEVER bodies. Designed as the
 * cheap primary input to deep-context-gather sub-Mos that need to
 * scan many candidates and pick a few to drill into.
 *
 * Filters (all optional, AND-combined):
 *   - `folderId`: scope to one folder
 *   - `clusterId`: only notes assigned to this cluster
 *   - `search`: optional FTS keyword filter (Mo-internal, sees archived)
 *
 * Mo elevation pattern (same as mo_search): when called by a regular
 * `mcp:*` actor, internally elevates to `morion-concierge` so archived
 * notes / notes in archived folders surface (per Phase 3 invariant).
 * Outer Pro / Mo-enabled / folder-read-perm gates run against the
 * ORIGINAL caller before elevation.
 */
export const moListTasksMetaTool = defineTool({
  name: 'mo_list_tasks_meta',
  category: 'read',
  description:
    "Bulk-fetch task / note metadata (id + title + summary + keywords + cluster ids + status) WITHOUT bodies. Designed as the cheap candidate-scan input for deep-context-gather sub-Mos. Optional folder / cluster / search filters AND-combine. Requires the folder to have Mo enabled when folderId is set.",
  inputShape: {
    folderId: z
      .string()
      .optional()
      .describe(
        'Optional folder scope. The folder must have Mo enabled when set. Unscoped reads span every Mo-readable note in the workspace.',
      ),
    clusterId: z
      .string()
      .optional()
      .describe(
        'Optional cluster filter. Only notes with this cluster assignment in note_mo_clusters are returned.',
      ),
    search: z
      .string()
      .optional()
      .describe(
        'Optional FTS keyword filter. Hybrid BM25 + vector — same engine as notes_search. Combined with folder/cluster via intersection.',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe('Max metas returned. Default 50, max 200.'),
  },
  async handler(input, ctx) {

    if (input.folderId !== undefined) {
      const moGate = requireMoEnabledForFolder(ctx, input.folderId);
      if (moGate) return moGate;
      if (!canPerform('read', ctx, { kind: 'folder', folderId: input.folderId })) {
        return ACCESS_DENIED;
      }
    }

    const limit = input.limit ?? 50;
    const moCtx = toMoInternalCtx(ctx);

    // Resolve candidate note ids — three optional filters compose:
    //  - search → search.search() result set
    //  - clusterId → SELECT FROM note_mo_clusters
    //  - folderId → SELECT FROM notes WHERE folder_id = ?
    // When all three given: intersect. When none: notes.recent fallback.

    let candidateIds: string[];
    if (input.search) {
      const hits = await ctx.search.search(input.search, {
        limit: Math.min(limit * 2, 200),
        folderId: input.folderId,
        cluster: input.clusterId ? [input.clusterId] : undefined,
        includeArchived: true,
      });
      candidateIds = hits.map((h) => h.note.id);
    } else if (input.clusterId) {
      interface Row {
        note_id: string;
      }
      let rows: Row[];
      if (input.folderId) {
        rows = ctx.db
          .prepare<[string, string, number], Row>(
            `SELECT c.note_id FROM note_mo_clusters c
               JOIN notes n ON n.id = c.note_id
              WHERE c.cluster_id = ?
                AND n.deleted_at IS NULL
                AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
                AND n.folder_id = ?
              ORDER BY c.confidence DESC
              LIMIT ?`,
          )
          .all(input.clusterId, input.folderId, limit);
      } else {
        rows = ctx.db
          .prepare<[string, number], Row>(
            `SELECT c.note_id FROM note_mo_clusters c
               JOIN notes n ON n.id = c.note_id
              WHERE c.cluster_id = ?
                AND n.deleted_at IS NULL
                AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
              ORDER BY c.confidence DESC
              LIMIT ?`,
          )
          .all(input.clusterId, limit);
      }
      candidateIds = rows.map((r) => r.note_id);
    } else if (input.folderId) {
      const folderNotes = ctx.notes.list({
        folderId: input.folderId,
        limit,
        offset: 0,
      });
      candidateIds = folderNotes.map((n) => n.id);
    } else {
      const recent = ctx.notes.recent(limit);
      candidateIds = recent.map((n) => n.id);
    }

    // Per-note fetch + permission post-filter through elevated ctx so
    // archive bypass applies. moClusters / moMetadata are batch reads.
    const visibleIds: string[] = [];
    for (const id of candidateIds) {
      if (canPerform('read', moCtx, { kind: 'note', noteId: id })) {
        visibleIds.push(id);
      }
    }

    const metaByNoteId =
      ctx.concierge?.moMetadata?.getMany(visibleIds) ?? new Map();
    const clustersByNoteId =
      ctx.concierge?.moClusters?.listClusterIdsForNotes(visibleIds) ?? new Map();

    const items = visibleIds.flatMap((id) => {
      const note = ctx.notes.getById(id);
      if (!note) return [];
      const meta = metaByNoteId.get(id) ?? null;
      return [
        {
          noteId: id,
          title: note.title,
          folderId: note.folderId,
          status: note.status,
          tags: note.tags,
          summary: meta?.summary ?? null,
          keywords: meta?.keywords ?? null,
          clusters: clustersByNoteId.get(id) ?? [],
          updatedAt: note.updatedAt,
        },
      ];
    });

    return {
      filters: {
        folderId: input.folderId ?? null,
        clusterId: input.clusterId ?? null,
        search: input.search ?? null,
      },
      items,
      totalReturned: items.length,
    };
  },
});
