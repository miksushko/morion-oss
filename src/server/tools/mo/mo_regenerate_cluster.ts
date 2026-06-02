import { z } from 'zod';
import { defineTool } from '../types.js';
import { canPerform, ACCESS_DENIED } from '../../../core/permissions/check.js';
import {
  requireMoEnabledForFolder,
  MO_INTERNAL_NOT_WIRED,
} from './gate.js';
import { runTier2ForCluster } from '../../../core/concierge/index.js';
import { resolveMoIndexingProvider } from '../../features/concierge-deps/index.js';

/**
 * Mo Indexing Redesign Phase 5c — `mo_regenerate_cluster` MCP tool.
 *
 * Force-fires `runTier2ForCluster` on a single cluster, ignoring the
 * 60-second debounce. Use when the user just wrote a bunch of notes
 * into a cluster and wants the aggregator note refreshed RIGHT NOW
 * instead of waiting for the next minute tick.
 *
 * Mo-enabled-folder + per-folder MCP read perm gates.
 * Backend must be OpenRouter with a key.
 */
export const moRegenerateClusterTool = defineTool({
  name: 'mo_regenerate_cluster',
  category: 'update',
  description:
    "Force-regenerate the mo:cluster:<clusterId> aggregator note for one cluster, ignoring the 60-second debounce. Reads every note assigned to the cluster (via note_mo_clusters JOIN), feeds Tier 1 summaries into the mid-tier model, merges into the aggregator note preserving user prose outside <!-- mo:section-* --> anchors. Pro + Mo-enabled folder; OpenRouter required.",
  inputShape: {
    folderId: z.string().min(1).describe('The Morion folder id.'),
    clusterId: z
      .string()
      .min(1)
      .describe(
        'The cluster id to regenerate (e.g. "kanban-ui"). Look it up via mo_list_clusters or via note_mo_clusters.',
      ),
  },
  async handler(input, ctx) {

    const moGate = requireMoEnabledForFolder(ctx, input.folderId);
    if (moGate) return moGate;

    if (!canPerform('read', ctx, { kind: 'folder', folderId: input.folderId })) {
      return ACCESS_DENIED;
    }

    if (
      !ctx.concierge ||
      !ctx.concierge.moMetadata ||
      !ctx.concierge.moClusters
    ) {
      return MO_INTERNAL_NOT_WIRED;
    }

    const provider = resolveMoIndexingProvider({
      db: ctx.db,
      notes: ctx.notes,
      folders: ctx.folders,
      comments: ctx.comments,
      settings: ctx.settings,
      concierge: ctx.concierge,
    });
    if (!provider) {
      return {
        error: 'mo_backend_not_openrouter',
        reason: 'wrong_backend_or_missing_key',
        message:
          'Mo metadata indexing requires OpenRouter as the active Mo backend with a configured key. Set this in Mo settings, then retry.',
      };
    }

    const result = await runTier2ForCluster(
      {
        db: ctx.db,
        notes: ctx.notes,
        metaRepo: ctx.concierge.moMetadata,
        clustersRepo: ctx.concierge.moClusters,
        provider: provider.provider,
        budget: ctx.concierge.budget,
        model: provider.tier2Model,
        fallbackModel: provider.tier2FallbackModel,
      },
      input.folderId,
      input.clusterId,
    );

    return {
      folderId: input.folderId,
      clusterId: input.clusterId,
      ...result,
    };
  },
});
