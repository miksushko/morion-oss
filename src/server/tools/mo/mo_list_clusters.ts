import { z } from 'zod';
import { defineTool } from '../types.js';
import { canPerform, ACCESS_DENIED } from '../../../core/permissions/check.js';
import {
  requireMoEnabledForFolder,
} from './gate.js';
import { findClusterNoteId } from '../../../core/concierge/index.js';

/**
 * Phase 6 primitive — context restructure ticket
 * `01KQFQ1RJV7EH0X3WF2H1A476J`.
 *
 * Cheap deterministic enumeration of every cluster id present in a
 * folder, plus per-cluster task count and a "has-aggregator-doc" flag.
 * No LLM call. Use this as the cheap first step before fanning into
 * `mo_get_cluster` for cluster bodies the agent actually wants to read.
 */
export const moListClustersTool = defineTool({
  name: 'mo_list_clusters',
  category: 'read',
  description:
    "List every cluster id assigned in a folder, with task count + whether a mo:cluster aggregator note exists for each. Cheap deterministic SQL — no LLM call. Use as the cheap first step before opening cluster bodies via mo_get_cluster. Requires the folder to have Mo enabled.",
  inputShape: {
    folderId: z
      .string()
      .min(1)
      .describe(
        'Morion folder id whose clusters to enumerate. The folder must have Mo enabled.',
      ),
  },
  async handler(input, ctx) {

    const moGate = requireMoEnabledForFolder(ctx, input.folderId);
    if (moGate) return moGate;

    if (!canPerform('read', ctx, { kind: 'folder', folderId: input.folderId })) {
      return ACCESS_DENIED;
    }

    interface Row {
      cluster_id: string;
      task_count: number;
    }
    // Same `mo:*` system-note exclusion every other indexing-aware
    // path enforces — Mo's own notes never appear as clusters.
    const rows = ctx.db
      .prepare<[string], Row>(
        `SELECT c.cluster_id, COUNT(c.note_id) AS task_count
           FROM note_mo_clusters c
           JOIN notes n ON n.id = c.note_id
          WHERE n.folder_id = ?
            AND n.deleted_at IS NULL
            AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
          GROUP BY c.cluster_id
          ORDER BY task_count DESC, c.cluster_id ASC`,
      )
      .all(input.folderId);

    const clusters = rows.map((r) => {
      const aggregatorNoteId = findClusterNoteId(ctx.db, input.folderId, r.cluster_id);
      return {
        clusterId: r.cluster_id,
        taskCount: r.task_count,
        aggregatorNoteId,
        hasAggregator: aggregatorNoteId !== null,
      };
    });

    return {
      folderId: input.folderId,
      clusters,
      totalClusters: clusters.length,
      hint:
        clusters.length === 0
          ? 'No clusters yet. Either Tier 1 hasn\'t indexed this folder yet, or no notes have been classified into themes.'
          : null,
    };
  },
});
