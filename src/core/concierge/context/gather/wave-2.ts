import { toMoInternalCtx } from '../../mo-elevate.js';
import { runSubMoBatch } from '../../sub-mo-template.js';
import { bodyExtractorRole } from '../../sub-mo-roles.js';
import type {
  GatherInput,
  GatherDeps,
  GatherCaps,
  GatherProgressEvent,
} from '../types.js';
import type { BootstrapState } from './bootstrap-state.js';
import type { Wave1Output, Wave2Output } from './wave-types.js';
import { truncate } from './helpers.js';

/**
 * Wave 2 — runs the body-extractor sub-Mo on every note Wave 1's
 * cluster-analysts asked us to drill into, deduped + capped at
 * `caps.maxBodyReads`. Also runs a cross-workspace keyword search
 * for the synthesizer's "candidate notes not drilled into" section,
 * gated on either `scope='workspace'` OR a question-mode call that
 * returned no cluster findings (so question-mode always has
 * candidates to render even without a starting task).
 *
 * CRITICAL invariant — `bodyTargets` and `bodyScopes` are built in
 * lock-step. The post-batch loop drives indexing by `bodyTargets`
 * (1:1 with `bodyScopes` → `bodyBatch.results`) NOT by
 * `bodyTargetIds` (a Set whose iteration order may include
 * filter-skipped ghost ids). Drifting the index reader past
 * `bodyBatch.results.length` produced the canonical "Cannot read
 * properties of undefined (reading 'ok')" crash documented in
 * regression 01KR5FBYS9QRM60BMX54DR1XZR.
 *
 * Per-note skips:
 *   - note resolution fails (deleted / hidden / typoed id from
 *     cluster analyst): skipped at build time, no scope created
 *   - sub-Mo returns empty `chunks` + empty `why`: skipped silently
 *     per the role contract (means "nothing relevant found")
 *   - sub-Mo fails: warning surfaced, not aborted
 */
export async function runWave2(
  input: GatherInput,
  bootstrap: BootstrapState,
  wave1: Wave1Output,
  deps: GatherDeps,
  caps: GatherCaps,
  emit: (e: GatherProgressEvent) => void,
): Promise<Wave2Output> {
  const moCtx = toMoInternalCtx(deps.ctx);
  const subagentDeps = {
    provider: deps.provider,
    model: deps.subagentModel,
    budget: deps.budget,
    // Same spendKind override as Wave 1 — Wave 2 body-extractors are
    // also gather-tier reads.
    spendKind: 'mo_gather' as const,
  };

  // Collect body-extractor candidates: every drillIntoNoteId from
  // Wave 1's cluster analysts, deduped, capped at maxBodyReads.
  const bodyTargetIds = new Set<string>();
  for (const finding of wave1.clusterFindings) {
    for (const id of finding.drillIntoNoteIds) {
      if (bodyTargetIds.size >= caps.maxBodyReads) break;
      bodyTargetIds.add(id);
    }
  }

  // Cross-workspace search by keywords (only when scope = workspace
  // OR when no clusters were found — gives Wave 2 something to chew
  // on for question-mode calls).
  const scope: 'folder' | 'workspace' =
    input.scope ?? (input.folderId ? 'folder' : 'workspace');
  const workspaceCandidates: Wave2Output['workspaceCandidates'] = [];
  if (
    scope === 'workspace' ||
    (input.question && wave1.clusterFindings.length === 0)
  ) {
    const seen = new Set<string>(bodyTargetIds);
    for (const kw of wave1.keywords.slice(0, 6)) {
      const hits = await moCtx.search.search(kw, {
        limit: 12,
        folderId: scope === 'folder' ? input.folderId ?? undefined : undefined,
        includeArchived: true,
      });
      for (const hit of hits) {
        if (seen.has(hit.note.id)) continue;
        if (workspaceCandidates.length >= 20) break;
        seen.add(hit.note.id);
        const meta = moCtx.concierge?.moMetadata?.get(hit.note.id) ?? null;
        workspaceCandidates.push({
          noteId: hit.note.id,
          title: hit.note.title,
          summary: meta?.summary ?? null,
          folderId: hit.note.folderId,
        });
      }
      if (workspaceCandidates.length >= 20) break;
    }
  }

  // Build body-extractor scopes. CRITICAL: keep the id list and the
  // scopes list in lock-step. Earlier code used `bodyTargetIds` (Set)
  // for the post-batch loop and a SEPARATE `bodyScopes` array for
  // the batch input — when a note couldn't be loaded (deleted /
  // hidden / typoed id from the cluster analyst), `bodyScopes`
  // skipped the entry but `bodyTargetIds` still iterated it,
  // drifting the index reader past `bodyBatch.results.length`. That
  // produced the canonical "Cannot read properties of undefined
  // (reading 'ok')" crash on the first ghost id (ticket
  // 01KR5FBYS9QRM60BMX54DR1XZR). Building parallel arrays makes the
  // 1:1 invariant structural — adding new filter conditions can't
  // re-introduce the drift.
  const bodyTargets: Array<{ id: string; note: { title: string; folderId: string | null } }> =
    [];
  const bodyScopes: Array<{ scope: string; folderId?: string | null }> = [];
  for (const id of bodyTargetIds) {
    const note = moCtx.notes.getById(id);
    if (!note) continue;
    const askingAbout = input.taskId
      ? `Title: ${bootstrap.taskTitle}\nBody: ${truncate(bootstrap.taskBody ?? '', 1000)}`
      : `Question: ${input.question}`;
    const scopeText = [
      `# Agent's question / task`,
      askingAbout,
      ``,
      `# Note to extract from`,
      `id: ${id}`,
      `title: ${note.title}`,
      `body:`,
      truncate(note.body ?? '', 4000),
    ].join('\n');
    bodyScopes.push({ scope: scopeText, folderId: note.folderId });
    bodyTargets.push({ id, note });
  }

  emit({ kind: 'wave_start', wave: 2, subMoCount: bodyScopes.length });

  if (bodyScopes.length === 0) {
    emit({
      kind: 'wave_complete',
      wave: 2,
      okCount: 0,
      failedCount: 0,
      spentUsd: 0,
    });
    return {
      bodyExtractions: [],
      workspaceCandidates,
      spentUsd: 0,
      warnings: [],
    };
  }

  const bodyBatch = await runSubMoBatch(
    subagentDeps,
    bodyExtractorRole,
    bodyScopes,
    { concurrency: caps.subagentConcurrency },
  );

  const bodyExtractions: Wave2Output['bodyExtractions'] = [];
  const warnings: string[] = [];
  // Drive the result loop by `bodyTargets` (1:1 with `bodyScopes`
  // and therefore `bodyBatch.results`) instead of by `bodyTargetIds`
  // (Set, may include filtered-out ghosts). See the bodyTargets
  // build above for the bug-01KR5FBYS9QRM60BMX54DR1XZR root cause.
  for (let idx = 0; idx < bodyBatch.results.length; idx++) {
    const result = bodyBatch.results[idx]!;
    const target = bodyTargets[idx]!;
    if (!result.ok) {
      warnings.push(`body-extractor on note ${target.id} failed: ${result.reason}`);
      continue;
    }
    if (result.data.chunks.length === 0 && result.data.why.length === 0) {
      // Sub-Mo found nothing relevant — skip silently (per role contract).
      continue;
    }
    bodyExtractions.push({
      noteId: target.id,
      title: target.note.title,
      chunks: result.data.chunks,
      why: result.data.why,
      isWarning: result.data.isWarning,
    });
  }

  emit({
    kind: 'wave_complete',
    wave: 2,
    okCount: bodyBatch.okCount,
    failedCount: bodyBatch.failedCount,
    spentUsd: bodyBatch.totalCostUsd,
  });

  return {
    bodyExtractions,
    workspaceCandidates,
    spentUsd: bodyBatch.totalCostUsd,
    warnings,
  };
}
