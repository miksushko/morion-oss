import { z } from 'zod';
import { defineTool } from '../types.js';
import type { ToolContext } from '../types.js';
import { canPerform, ACCESS_DENIED } from '../../../core/permissions/check.js';
import {
  requireMoEnabledForFolder,
  MO_INTERNAL_NOT_WIRED,
} from './gate.js';
import {
  hashBody,
  runMoIndexingTick,
  type MoIndexingTickDeps,
} from '../../../core/concierge/index.js';
import { buildMoIndexingDeps } from '../../features/concierge-deps/index.js';

/**
 * Mo Indexing Redesign Phase 5c — `mo_patrol` MCP tool.
 *
 * Force-runs `runMoIndexingTick` outside the regular minute cadence.
 * Two modes:
 *
 *   incremental (default)
 *     Run the tick once. Audit-log polling + Tier 1 drain + Tier 2
 *     drain + Tier 2.5 catalog regen — same path the scheduler runs.
 *     Use when the user wants "process whatever's pending right now".
 *
 *   backfill
 *     Enqueue every eligible note in the folder (live body_hash) into
 *     `mo_metadata_queue` BEFORE running the tick. Use when Mo was
 *     just enabled on a folder with pre-existing notes — audit_log
 *     wouldn't catch them otherwise (their create rows pre-date the
 *     checkpoint).
 *
 * Returns the tick summary so the caller can see what changed.
 *
 * Mo-enabled-folder + per-folder MCP read perm gates.
 * Backend must be OpenRouter with a key (Tier 1+ otherwise no-ops);
 * the call returns `gated_off` cleanly when not.
 */
export const moPatrolTool = defineTool({
  name: 'mo_patrol',
  category: 'update',
  description:
    "Force-run the Mo metadata indexing pipeline (Tier 0 → 1 → 2 → 2.5) for one folder, outside the scheduler's minute cadence. mode='incremental' (default) just runs a tick; mode='backfill' first enqueues every eligible note in the folder so Mo can pick up notes created before Mo was enabled. Returns the tick summary. Pro + Mo-enabled folder; OpenRouter must be the active Mo backend with a key.",
  inputShape: {
    folderId: z
      .string()
      .min(1)
      .describe(
        'The Morion folder id to patrol. Must have Mo enabled (folder settings → AI Access → Enable Mo).',
      ),
    mode: z
      .enum(['incremental', 'backfill'])
      .optional()
      .describe(
        "incremental (default): just run a tick. backfill: enqueue every eligible note in the folder before the tick — use this when Mo was just enabled on a folder with pre-existing notes.",
      ),
  },
  async handler(input, ctx) {

    const moGate = requireMoEnabledForFolder(ctx, input.folderId);
    if (moGate) return moGate;

    if (!canPerform('read', ctx, { kind: 'folder', folderId: input.folderId })) {
      return ACCESS_DENIED;
    }

    if (!ctx.concierge) return MO_INTERNAL_NOT_WIRED;

    const deps = buildMoIndexingDepsFromCtx(ctx);
    if (!deps) return MO_INTERNAL_NOT_WIRED;

    const mode = input.mode ?? 'incremental';
    const now = Date.now();

    if (mode === 'backfill') {
      // Enqueue every non-archived, non-deleted note in the folder
      // with its CURRENT body_hash. The queue's coalescing INSERT
      // means re-enqueueing a note that's already pending just
      // refreshes the dirty mark — no duplicate work.
      const noteRows = ctx.db
        .prepare<[string], { id: string; body: string }>(
          `SELECT id, body FROM notes
            WHERE folder_id = ?
              AND deleted_at IS NULL
              AND archived_at IS NULL`,
        )
        .all(input.folderId);
      for (const row of noteRows) {
        deps.metadataQueue.enqueue(
          input.folderId,
          row.id,
          'tier1',
          hashBody(row.body),
          now,
        );
      }
    }

    const summary = await runMoIndexingTick(deps);
    return {
      mode,
      folderId: input.folderId,
      tickStatus: summary.status,
      enqueued: summary.enqueued,
      newCheckpoint: summary.newCheckpoint,
      tier1: summary.worker
        ? {
            claimed: summary.worker.claimed,
            computed: summary.worker.computed,
            fresh: summary.worker.fresh,
            errors: summary.worker.errors,
            abandoned: summary.worker.abandoned,
            dirtyClusters: summary.worker.dirtyClusters,
          }
        : null,
      tier2: summary.tier2
        ? {
            claimed: summary.tier2.claimed,
            computed: summary.tier2.computed,
            empty: summary.tier2.empty,
            errors: summary.tier2.errors,
            abandoned: summary.tier2.abandoned,
            computedFolders: summary.tier2.computedFolders,
          }
        : null,
      tier25Attempted: summary.tier25?.length ?? 0,
      tier25Computed:
        summary.tier25?.filter((r) => r.status === 'computed').length ?? 0,
    };
  },
});

function buildMoIndexingDepsFromCtx(
  ctx: ToolContext,
): MoIndexingTickDeps | null {
  // Mirrors `buildMoIndexingDeps(host)` in concierge-deps.ts but
  // sourced from a ToolContext. Both shapes carry the same fields;
  // duplicating is cheaper than narrowing types across module
  // boundaries that don't quite line up.
  if (!ctx.concierge) return null;
  return buildMoIndexingDeps({
    db: ctx.db,
    notes: ctx.notes,
    folders: ctx.folders,
    comments: ctx.comments,
    settings: ctx.settings,
    concierge: ctx.concierge,
    embeddings: ctx.embeddings,
  });
}
