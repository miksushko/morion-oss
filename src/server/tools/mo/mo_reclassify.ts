import { z } from 'zod';
import { defineTool } from '../types.js';
import { canPerform, ACCESS_DENIED } from '../../../core/permissions/check.js';
import {
  requireMoEnabledForFolder,
  MO_INTERNAL_NOT_WIRED,
} from './gate.js';

/**
 * Mo Indexing Redesign Phase 5c — `mo_reclassify` MCP tool.
 *
 * User override on `note_mo_clusters`: replaces the note's full
 * cluster assignment set with the supplied list, all rows tagged
 * `source='user'`. Subsequent Tier 1 reclassifications respect this
 * via the `preserveUserOverrides: true` contract in
 * `replaceForNote`.
 *
 * After replacement: every old AND new cluster is enqueued in
 * `mo_cluster_queue` so Tier 2 regenerates each affected aggregator.
 * The empty list is allowed — that's "remove this note from every
 * cluster" which is rare but legitimate.
 *
 * Mo-enabled-folder + per-folder MCP update perm gates.
 */
export const moReclassifyTool = defineTool({
  name: 'mo_reclassify',
  category: 'update',
  description:
    "User override on a note's cluster assignments. Replaces the full set with the supplied list, all rows tagged source='user' so Tier 1 reclassifications won't undo it. Marks every old AND new cluster dirty so Tier 2 regenerates each affected aggregator. Empty list = remove from every cluster. Pro + Mo-enabled folder.",
  inputShape: {
    noteId: z.string().min(1).describe('The Morion note id to reclassify.'),
    clusters: z
      .array(z.string().min(1))
      .describe(
        'The complete new set of cluster ids for this note. Pass [] to clear all assignments.',
      ),
  },
  async handler(input, ctx) {

    const note = ctx.notes.getById(input.noteId);
    if (!note) {
      return {
        error: 'note_not_found',
        message: `Note ${input.noteId} not found.`,
      };
    }
    if (note.folderId === null) {
      return {
        error: 'note_unfiled',
        message:
          'Cannot reclassify an unfiled note — Mo-enabled folder required for cluster assignment.',
      };
    }

    const moGate = requireMoEnabledForFolder(ctx, note.folderId);
    if (moGate) return moGate;

    if (
      !canPerform('update', ctx, { kind: 'note', noteId: input.noteId })
    ) {
      return ACCESS_DENIED;
    }

    if (
      !ctx.concierge ||
      !ctx.concierge.moClusters ||
      !ctx.concierge.moClusterQueue
    ) {
      return MO_INTERNAL_NOT_WIRED;
    }

    const now = Date.now();

    // Capture the BEFORE-state cluster ids so we can mark them dirty
    // even if they're not in the new set (their aggregator notes
    // need a regen too — this note dropped out).
    const beforeClusterIds = ctx.concierge.moClusters
      .listForNote(input.noteId)
      .map((c) => c.clusterId);

    // Replace ALL assignments — user is asserting truth, override
    // any prior tier1/tier0/imported sources too.
    const after = ctx.concierge.moClusters.replaceForNote(
      input.noteId,
      input.clusters.map((clusterId) => ({
        clusterId,
        confidence: 1.0,
        source: 'user' as const,
      })),
      { preserveUserOverrides: false },
      now,
    );

    // Mark every touched cluster dirty so Tier 2 regenerates each
    // aggregator on the next tick. Old clusters need it because the
    // note dropped out; new clusters need it because the note joined.
    const touched = new Set<string>([
      ...beforeClusterIds,
      ...input.clusters,
    ]);
    for (const clusterId of touched) {
      ctx.concierge.moClusterQueue.enqueue(note.folderId, clusterId, now);
    }

    return {
      noteId: input.noteId,
      folderId: note.folderId,
      removed: beforeClusterIds.filter((c) => !input.clusters.includes(c)),
      added: input.clusters.filter((c) => !beforeClusterIds.includes(c)),
      retained: input.clusters.filter((c) => beforeClusterIds.includes(c)),
      assignments: after.map((c) => ({
        clusterId: c.clusterId,
        source: c.source,
        confidence: c.confidence,
      })),
      dirtyClustersQueued: Array.from(touched),
    };
  },
});
