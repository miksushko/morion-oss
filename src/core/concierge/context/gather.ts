import { hashBody } from '../mo-tier1.js';
import { runSubMoTask } from '../sub-mo-template.js';
import { gatherSynthesizerRole } from '../sub-mo-roles.js';
import {
  buildExactCacheKey,
  type MoContextCacheRepository,
} from '../mo-context-cache.js';
import {
  type GatherInput,
  type GatherDeps,
  type GatherCaps,
  type WorkContextPacket,
  type GatherProgressEvent,
  DEFAULT_GATHER_CAPS,
} from './types.js';
import { safeEmbed } from './gather/helpers.js';
import { validateInput } from './gather/validate.js';
import {
  renderFallbackPacket,
  emptyPacket,
  synthesisSkippedPacket,
  rehydrateCachedPacket,
} from './gather/fallback-packets.js';
import { buildSynthesizerInput } from './gather/synthesize.js';
import {
  resolveBootstrapKeyParts,
  runBootstrap,
} from './gather/bootstrap.js';
import { runWave1 } from './gather/wave-1.js';
import { runWave2 } from './gather/wave-2.js';

/**
 * Phase 7 — context restructure ticket `01KQFQ1RJV7EH0X3WF2H1A476J`.
 *
 * Deep-context-gather engine. Used by `mo_get_context` (returns the
 * packet) and `mo_ask` (post-formats the packet's markdown). One
 * consistent, cap-bounded, best-effort, cache-aware shape — replaces
 * the deleted `mo_get_work_context` (keyword ranking) and is the
 * intended target for the upcoming `mo_ask` refactor.
 *
 * Pipeline:
 *   1. Cache check (exact then semantic) → return on hit
 *   2. Bootstrap (sync, no LLM): resolve task or read catalog
 *   3. Wave 1: keyword-generator + (taskId path) cluster-analyst per cluster
 *   4. Wave 2: body-extractor on selected ids + cross-folder candidates
 *   5. Synth: gather-synthesizer composes the packet
 *   6. Cache write
 *
 * Hard caps fire at every wave boundary. Best-effort partial: when a
 * sub-Mo batch fails >50% the engine still proceeds to synth with
 * whatever it got, surfacing a warning.
 */
export async function gatherContext(
  input: GatherInput,
  deps: GatherDeps,
): Promise<WorkContextPacket> {
  validateInput(input);
  const caps: GatherCaps = { ...DEFAULT_GATHER_CAPS, ...(deps.caps ?? {}) };
  const emit = (event: GatherProgressEvent): void => {
    try {
      deps.onProgress?.(event);
    } catch {
      // never let a faulty progress callback crash the gather.
    }
  };

  const scope: 'folder' | 'workspace' =
    input.scope ?? (input.folderId ? 'folder' : 'workspace');
  const mode = input.mode ?? 'full';

  // ---------------------------------------------------------------
  // 0. Pre-flight budget gate. Refuse calls when Mo's monthly cap
  //    has less headroom than the per-call cap.
  // ---------------------------------------------------------------
  const preBudget = deps.budget.status();
  const remaining = preBudget.monthlyCapUsd - preBudget.spentMonthUsd;
  if (preBudget.withinBudget === false || remaining < caps.maxUsd) {
    emit({ kind: 'capped', reason: 'budget_exhausted' });
    return emptyPacket({
      mode,
      scope,
      capped: 'budget_exhausted',
      warnings: [
        `Workspace monthly Mo budget has $${remaining.toFixed(4)} remaining; gather call requires up to $${caps.maxUsd}.`,
      ],
    });
  }

  // ---------------------------------------------------------------
  // 1. Cache lookup (skipped on `force: true`).
  // ---------------------------------------------------------------
  const cache = deps.ctx.concierge?.moContextCache ?? null;
  let cacheKey: string | null = null;
  if (!input.force && cache) {
    const bootstrapForKey = await resolveBootstrapKeyParts(input, deps);
    cacheKey = buildExactCacheKey({
      taskId: input.taskId ?? null,
      taskBodyHash: bootstrapForKey.taskBodyHash,
      folderCatalogHash: bootstrapForKey.folderCatalogHash,
      mode,
      scope,
      extra: input.question ? hashBody(input.question) : null,
    });

    const exactHit = cache.lookupExact(cacheKey);
    if (exactHit) {
      emit({ kind: 'cache_hit_exact', cacheKey });
      return rehydrateCachedPacket(exactHit.packetJson, {
        mode,
        scope,
        cacheHit: { kind: 'exact' },
      });
    }

    // Semantic match (only meaningful for question-mode calls — the
    // taskId path's exact key already covers the same body+catalog
    // combination the semantic match would shortlist).
    if (input.question && deps.ctx.embeddings) {
      const queryEmbedding = await safeEmbed(deps.ctx.embeddings, input.question);
      if (queryEmbedding) {
        const semHit = cache.lookupSemantic(queryEmbedding, { mode, scope });
        if (semHit) {
          emit({ kind: 'cache_hit_semantic', similarity: semHit.similarity });
          return rehydrateCachedPacket(semHit.row.packetJson, {
            mode,
            scope,
            cacheHit: { kind: 'semantic', similarity: semHit.similarity },
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------
  // 2. Bootstrap.
  // ---------------------------------------------------------------
  const bootstrap = await runBootstrap(input, deps);
  emit({
    kind: 'bootstrap_complete',
    folderId: bootstrap.folderId,
    clusterCount: bootstrap.clusterIds.length,
  });

  let totalSpent = 0;
  const warnings: string[] = [];
  let cappedReason: WorkContextPacket['capped'] = null;

  // Helper to enforce per-wave budget cap.
  const checkBudget = (): boolean => {
    const status = deps.budget.status();
    const remainingNow = status.monthlyCapUsd - status.spentMonthUsd;
    if (!status.withinBudget || remainingNow < caps.maxUsd / 2) {
      cappedReason = 'budget_exhausted';
      emit({ kind: 'capped', reason: 'budget_exhausted' });
      return false;
    }
    if (totalSpent >= caps.maxUsd) {
      cappedReason = 'budget_exhausted';
      emit({ kind: 'capped', reason: 'budget_exhausted' });
      return false;
    }
    return true;
  };

  // ---------------------------------------------------------------
  // 3. Wave 1 — keywords + (taskId path) per-cluster analysts.
  // ---------------------------------------------------------------
  const wave1 = await runWave1(input, bootstrap, deps, caps, emit);
  totalSpent += wave1.spentUsd;
  warnings.push(...wave1.warnings);
  if (!checkBudget()) {
    return synthesisSkippedPacket({
      mode,
      scope,
      bootstrap,
      warnings,
      capped: cappedReason,
      spentUsd: totalSpent,
    });
  }

  // ---------------------------------------------------------------
  // 4. Wave 2 — body-extractor on selected ids.
  // ---------------------------------------------------------------
  if (caps.maxWaves < 2) {
    cappedReason = 'wave_cap';
    emit({ kind: 'capped', reason: 'wave_cap' });
    return synthesisSkippedPacket({
      mode,
      scope,
      bootstrap,
      warnings,
      capped: cappedReason,
      spentUsd: totalSpent,
    });
  }
  const wave2 = await runWave2(input, bootstrap, wave1, deps, caps, emit);
  totalSpent += wave2.spentUsd;
  warnings.push(...wave2.warnings);
  if (!checkBudget()) {
    return synthesisSkippedPacket({
      mode,
      scope,
      bootstrap,
      warnings,
      capped: cappedReason,
      spentUsd: totalSpent,
    });
  }

  // ---------------------------------------------------------------
  // 5. Synth.
  // ---------------------------------------------------------------
  emit({ kind: 'synthesis_start' });
  // Mo workspace memory propagates into EVERY persona-bearing prompt
  // (CLAUDE.md "Workspace-wide memory ... must be wired into every
  // prompt builder that produces that voice"). Read fresh per call so
  // user edits in Settings → Mo Memory take effect immediately.
  const workspaceMemory =
    deps.ctx.concierge?.moMemory.read().trim() || null;
  const synthInput = buildSynthesizerInput({
    input,
    bootstrap,
    wave1,
    wave2,
    workspaceMemory,
  });
  const synthResult = await runSubMoTask(
    {
      provider: deps.provider,
      model: deps.synthesisModel,
      budget: deps.budget,
    },
    gatherSynthesizerRole,
    synthInput,
    { folderId: input.folderId ?? null, temperature: 0.3 },
  );
  totalSpent += synthResult.costUsd;
  emit({ kind: 'synthesis_complete', spentUsd: synthResult.costUsd });

  let packetMarkdown = '';
  let citedNoteIds: string[] = [];
  let risks: string[] = [];
  if (synthResult.ok) {
    packetMarkdown = synthResult.data.packetMarkdown;
    citedNoteIds = synthResult.data.citedNoteIds;
    risks = synthResult.data.risks;
  } else {
    warnings.push(
      `Synthesis failed (${synthResult.reason}${synthResult.errorMessage ? ': ' + synthResult.errorMessage : ''}). Returning bootstrap-only packet.`,
    );
    packetMarkdown = renderFallbackPacket(bootstrap);
  }

  const packet: WorkContextPacket = {
    mode,
    scope,
    bootstrap: {
      taskId: bootstrap.taskId,
      folderId: bootstrap.folderId,
      clusterIds: bootstrap.clusterIds,
      commentCount: bootstrap.comments.length,
      auditCount: bootstrap.audit.length,
    },
    synthesizedMarkdown: packetMarkdown,
    citedNoteIds,
    risks,
    cacheHit: null,
    spentUsd: totalSpent,
    capped: cappedReason,
    warnings,
  };

  // ---------------------------------------------------------------
  // 6. Cache write.
  // ---------------------------------------------------------------
  if (cacheKey && cache && synthResult.ok) {
    const questionEmbedding =
      input.question && deps.ctx.embeddings
        ? await safeEmbed(deps.ctx.embeddings, input.question)
        : null;
    cache.insert({
      cacheKey,
      packetJson: JSON.stringify(packet),
      questionEmbedding,
      mode,
      scope,
    });
  }

  return packet;
}



// Marker re-export so the type is stable from this module.
export type { MoContextCacheRepository };
