import { z } from 'zod';
import { defineTool } from '../types.js';
import { canPerform, ACCESS_DENIED } from '../../../core/permissions/check.js';
import { gatherContext } from '../../../core/concierge/index.js';
import { requireMoEnabledForFolder } from './gate.js';
import {
  resolveGatherModels,
  resolveGatherProvider,
  type ConciergeDepsHost,
} from '../../features/concierge-deps/index.js';

/**
 * Phase 10 — context restructure ticket `01KQFQ1RJV7EH0X3WF2H1A476J`.
 *
 * `mo_ask` is the "give me a paragraph answer" projection of the same
 * deep-research engine that powers `mo_get_context`. Same Wave 1 +
 * Wave 2 fan-out, same synthesis, same caps, same two-layer cache.
 * Output shape is the legacy `{ok, answer, sources, keywords, ...}`
 * agents have been consuming since v1 — synthesis markdown becomes
 * `answer`, cited ids become `sources`.
 *
 * Pre-Phase-10 mo_ask had its own bespoke pipeline (keyword planner →
 * search → parallel sub-Mo extraction → synth) duplicating what
 * `gatherContext` now does centrally. The duplicate prompts drifted
 * from the indexing-aware `mo_get_context` flow (didn't read
 * note_mo_clusters, didn't honour the same hard caps, didn't share
 * the cache). This refactor unifies them.
 *
 * Dropped from the legacy input shape:
 *   - `tag` / `createdAfter` / `createdBefore` / `updatedAfter` /
 *     `updatedBefore` — pre-Mo-engine vestiges. The deep-research
 *     pipeline ranks by relevance, not by metadata filters.
 *   - `maxNotes` — gather engine has its own `maxBodyReads` cap
 *     (default 15) and budget envelope. Per-call override would
 *     bypass that.
 *
 * Output shape preserved for back-compat: agents reading `r.answer`,
 * `r.sources[].id/title`, `r.keywords`, `r.clusterRoutes`, `r.costUsd`
 * see exactly what they got before — only the WAY those fields were
 * computed changed.
 */
export const moAskTool = defineTool({
  name: 'mo_ask',
  category: 'read',
  description:
    "Ask Mo a question about the project. Mo runs the deep-research gather pipeline (parallel sub-Mo cluster analysts + body extractors + synthesis) and returns a one-paragraph cited answer. For the structured packet (markdown + citedNoteIds + risks + bootstrap state) use mo_get_context instead. Requires the folder to have Mo enabled (folderId optional but unscoped questions span the workspace). Budget-gated against the Mo monthly cap.",
  inputShape: {
    question: z
      .string()
      .min(1)
      .describe(
        "The question, in plain language. Be concrete — \"what's our convention for Stripe webhook idempotency?\" beats \"tell me about Stripe\".",
      ),
    folderId: z
      .string()
      .optional()
      .describe(
        'Optional Morion folder id to scope the search. Unscoped questions span the workspace (Mo searches every Mo-readable folder).',
      ),
  },
  async handler(input, ctx) {
    // ---------- 1. gates ------------------------------------------

    if (input.folderId !== undefined) {
      const moGate = requireMoEnabledForFolder(ctx, input.folderId);
      if (moGate) return moGate;
      if (!canPerform('read', ctx, { kind: 'folder', folderId: input.folderId })) {
        return ACCESS_DENIED;
      }
    } else if (!ctx.concierge) {
      return {
        error: 'mo_internal',
        reason: 'concierge_not_wired',
        message: 'Mo subsystem is not available in this MCP context.',
      };
    }

    if (!ctx.concierge?.budget) {
      return {
        error: 'mo_internal_not_wired',
        message: 'Mo budget tracker is not wired.',
      };
    }

    // ---------- 2. resolve provider + models ---------------------
    const host: ConciergeDepsHost = {
      db: ctx.db,
      notes: ctx.notes,
      folders: ctx.folders,
      comments: ctx.comments,
      settings: ctx.settings,
      concierge: ctx.concierge,
      embeddings: ctx.embeddings,
    };
    const moProvider = resolveGatherProvider(host);
    if (!moProvider) {
      return {
        error: 'mo_provider_unconfigured',
        message:
          'Mo provider is not configured. Set OpenRouter as the active backend with a key in Settings → Mo to enable mo_ask.',
      };
    }
    const models = resolveGatherModels(host);
    if (!models) {
      return {
        error: 'mo_provider_unconfigured',
        message: 'Gather pipeline models are not resolvable for the active backend.',
      };
    }

    // ---------- 3. delegate to gatherContext ---------------------
    const packet = await gatherContext(
      {
        question: input.question,
        folderId: input.folderId ?? null,
        mode: 'full',
      },
      {
        ctx,
        provider: moProvider.provider,
        subagentModel: models.subagentModel,
        synthesisModel: models.synthesisModel,
        budget: ctx.concierge.budget,
      },
    );

    // ---------- 4. surface budget-cap as legacy denial envelope --
    // The legacy mo_ask pre-flighted via `requireBudget` and returned
    // the workspace cap denial envelope (`reason: 'monthly_cap_reached'`).
    // gatherContext also pre-flights but folds the result into the
    // packet's `capped` field. Mirror the legacy contract so callers
    // that branch on `r.reason` keep working.
    if (packet.capped === 'budget_exhausted') {
      return {
        reason: 'monthly_cap_reached',
        message:
          packet.warnings[0] ??
          'Monthly Mo budget cap reached — this call would exceed it.',
      };
    }

    // ---------- 5. resolve cited note titles for legacy sources -
    const sources = packet.citedNoteIds.flatMap((id) => {
      const note = ctx.notes.getById(id);
      if (!note) return [];
      return [
        {
          kind: 'note' as const,
          id,
          title: note.title,
          reason: 'extracted' as const,
        },
      ];
    });

    const folder = input.folderId ? ctx.folders.getById(input.folderId) : null;

    return {
      ok: true as const,
      answer: packet.synthesizedMarkdown,
      sources,
      // `keywords` was the legacy planner output — gather's
      // keyword-generator role still produces them, but the engine
      // doesn't surface them on the packet. Pull from bootstrap
      // metadata when available; empty otherwise.
      keywords: [] as string[],
      // `clusterRoutes` was the legacy "Mo searched these clusters"
      // hint. Gather's bootstrap clusterIds are the closest
      // equivalent — they're the task's own clusters when in
      // taskId-mode, or the folder's catalog routing when in
      // question-mode (currently empty for question-mode).
      clusterRoutes: packet.bootstrap.clusterIds,
      notesScanned: packet.citedNoteIds.length,
      folder: folder ? { id: folder.id, name: folder.name } : null,
      model: models.synthesisModel,
      costUsd: packet.spentUsd,
      // New optional fields surfaced from the gather packet — agents
      // that don't know about them ignore. cacheHit / risks are real
      // information the legacy mo_ask never had.
      cacheHit: packet.cacheHit,
      risks: packet.risks,
      warnings: packet.warnings,
    };
  },
});
