import { z } from 'zod';
import { defineTool } from '../types.js';
import { canPerform, ACCESS_DENIED } from '../../../core/permissions/check.js';
import { gatherContext, MO_ACTOR } from '../../../core/concierge/index.js';
import {
  requireMoEnabledForFolder,
} from './gate.js';
import {
  resolveGatherModels,
  resolveGatherProvider,
} from '../../features/concierge-deps/index.js';
import type { ConciergeDepsHost } from '../../features/concierge-deps/index.js';

/**
 * Phase 8 — context restructure ticket `01KQFQ1RJV7EH0X3WF2H1A476J`.
 *
 * `mo_get_context` is the high-level entry point for agents that want
 * Mo to do a deep-research gather on their behalf. Subsumes the
 * deleted `mo_get_work_context` (keyword-only one-shot ranking),
 * `mo_get_handoff` (per-task resume synthesis), and `mo_get_index`
 * (catalog body read — for the cluster directory use the new
 * `mo_list_clusters` primitive instead).
 *
 * Two starting modes (exactly one required):
 *   - `taskId`: bootstrap from an existing task (resolves folder +
 *     clusters + metadata + comments + audit), then fan-out per
 *     cluster + cross-folder search.
 *   - `question`: bootstrap from the catalog (when folderId given) or
 *     unscoped, then fan-out by generated keywords.
 *
 * Pipeline runs through `gatherContext` (see
 * `src/core/concierge/context/gather.ts`) — Wave 1 + Wave 2 parallel
 * sub-Mos on the cheap-tier model + one synthesis call. Hard caps:
 * $0.10 / call, max 3 waves, max 15 body reads. Two-layer cache
 * (exact-match + semantic) means the second identical call returns
 * for free.
 *
 * Mo is owner-level on reads (Phase 3): the engine elevates the
 * calling MCP context to `morion-concierge` internally so archived
 * notes / notes in archived folders surface in the gather. The user's
 * exclusion path is per-folder Mo enablement.
 */
export const moGetContextTool = defineTool({
  name: 'mo_get_context',
  category: 'read',
  description:
    "Ask Mo to do a deep-research gather for an agent task or general question. Returns a synthesised markdown packet + cited note ids + risks. Pipeline: bootstrap → parallel sub-Mo cluster analysts + keyword generator (Wave 1) → parallel body extractors + cross-folder candidates (Wave 2) → synth. Two-layer cache (exact + semantic) makes repeated calls free. Hard caps: $0.10/call default, 15 body reads max, 3 waves max. Mo is owner-level (sees archived). Pass `taskId` for task-scoped gather OR `question` for free-form, never both. Requires the folder to have Mo enabled when scoping to one.",
  inputShape: {
    taskId: z
      .string()
      .optional()
      .describe(
        "Morion note ULID for the task you want context on. Mutually exclusive with `question`. Resolves the parent folder + clusters automatically; you don't need to pass folderId.",
      ),
    question: z
      .string()
      .optional()
      .describe(
        "Free-form question Mo should gather context for (e.g. 'how do we deduplicate Stripe webhooks?'). Mutually exclusive with `taskId`. Pass `folderId` to scope to one folder; omit for workspace-wide.",
      ),
    folderId: z
      .string()
      .optional()
      .describe(
        "Optional folder scope when using `question`. Ignored when `taskId` is supplied (folder is resolved from the task). The folder must have Mo enabled.",
      ),
    scope: z
      .enum(['folder', 'workspace'])
      .optional()
      .describe(
        "Override the cross-folder search scope. Defaults to 'folder' when folderId is set, 'workspace' otherwise. 'workspace' lets Mo surface notes from other folders that match keywords.",
      ),
    mode: z
      .enum(['full', 'resume', 'thorough'])
      .optional()
      .describe(
        "'full' (default) — standard deep-research. 'resume' — handoff focus on recent task activity. 'thorough' — uses the stronger synth model (deepseek-v4-pro instead of v4-flash).",
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        'When true, bypass both cache layers and force a fresh synthesis. Use sparingly — cached packets are typically as good as fresh ones for the same task body.',
      ),
  },
  async handler(input, ctx) {
    // ---------- 0. input validation -------------------------------
    const hasTask = !!input.taskId;
    const hasQuestion = !!input.question;
    if (hasTask === hasQuestion) {
      return {
        error: 'invalid_input',
        message:
          'Exactly one of `taskId` or `question` must be supplied. Pass `taskId` for task-scoped gather; pass `question` for free-form research.',
      };
    }

    // ---------- 1. Pro gate ---------------------------------------

    // ---------- 2. resolve folderId (from task if needed) ---------
    let resolvedFolderId: string | null = input.folderId ?? null;
    if (input.taskId) {
      const task = ctx.notes.getById(input.taskId, { includeTrashed: true });
      if (!task) {
        return {
          error: 'task_not_found',
          message: `No note found with id ${input.taskId}.`,
        };
      }
      if (task.deletedAt !== null) {
        return {
          error: 'task_deleted',
          message: `Task ${input.taskId} is in trash.`,
        };
      }
      if (!task.folderId) {
        return {
          error: 'task_unfiled',
          message: `Task ${input.taskId} has no folder; Mo gates require a parent folder.`,
        };
      }
      resolvedFolderId = task.folderId;
    }

    // ---------- 3. per-folder Mo + read-perm gates ----------------
    if (resolvedFolderId !== null) {
      const moGate = requireMoEnabledForFolder(ctx, resolvedFolderId);
      if (moGate) return moGate;
      // Outer folder-read perm runs against the calling actor — Mo's
      // elevation only relaxes the per-note archive gate inside the
      // engine, not the caller's folder-level visibility.
      if (
        !canPerform('read', ctx, { kind: 'folder', folderId: resolvedFolderId })
      ) {
        return ACCESS_DENIED;
      }
    } else {
      // Unscoped (workspace-wide question). Concierge wiring required
      // — the engine reaches into ctx.concierge.budget at minimum.
      if (!ctx.concierge) {
        return {
          error: 'mo_internal_not_wired',
          message:
            'Mo concierge bag is not wired in this context. Production paths always supply it.',
        };
      }
    }

    if (!ctx.concierge?.budget) {
      return {
        error: 'mo_internal_not_wired',
        message: 'Mo budget tracker is not wired.',
      };
    }

    // ---------- 4. resolve provider + models from settings -------
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
          'Mo provider is not configured. In Settings → Mo, select a backend and add its key, then set the pipeline tier1 + tier2 models (OpenRouter ships built-in defaults; other backends need them set explicitly) to enable mo_get_context.',
      };
    }
    const models = resolveGatherModels(host);
    if (!models) {
      return {
        error: 'mo_provider_unconfigured',
        message:
          'Gather pipeline models are not resolvable for the active backend.',
      };
    }

    const mode = input.mode ?? 'full';
    const synthesisModel =
      mode === 'thorough' ? models.synthesisThoroughModel : models.synthesisModel;

    // ---------- 5. call gather engine -----------------------------
    // Thread the chat-tier progress callback into gather's onProgress
    // when it's set. The chat dispatch loop in routes/concierge.ts
    // populates `ctx._chatProgress.onGatherProgress` per tool call;
    // stdio MCP path leaves it undefined → gather runs silently as
    // before. Pinned by the SSE chat-progress wiring (Phase 11
    // streaming UX) so users don't see "Mo is thinking" for 60s
    // without feedback.
    const packet = await gatherContext(
      {
        taskId: input.taskId,
        question: input.question,
        folderId: resolvedFolderId,
        scope: input.scope,
        mode,
        force: input.force,
      },
      {
        ctx,
        provider: moProvider.provider,
        subagentModel: models.subagentModel,
        synthesisModel,
        budget: ctx.concierge.budget,
        onProgress: ctx._chatProgress?.onGatherProgress,
      },
    );

    // ---------- 6. wire-shape return ------------------------------
    // Strip the bootstrap state to bare counts + ids — the agent
    // doesn't need the full task body / comments back; they got those
    // already and `mo_resolve_task` is the dedicated full-bootstrap
    // primitive.
    return {
      mode: packet.mode,
      scope: packet.scope,
      packetMarkdown: packet.synthesizedMarkdown,
      citedNoteIds: packet.citedNoteIds,
      risks: packet.risks,
      bootstrap: packet.bootstrap,
      cacheHit: packet.cacheHit,
      spentUsd: packet.spentUsd,
      capped: packet.capped,
      warnings: packet.warnings,
      // Echo the elevation actor so the caller can see Mo ran owner-
      // level (audit trail still records `morion-concierge` for any
      // writes the gather happened to trigger via comments / metadata).
      ranAs: MO_ACTOR,
    };
  },
});
