import { toMoInternalCtx } from '../../mo-elevate.js';
import { runSubMoTask, runSubMoBatch } from '../../sub-mo-template.js';
import {
  keywordGeneratorRole,
  taskClusterAnalystRole,
} from '../../sub-mo-roles.js';
import type {
  GatherInput,
  GatherDeps,
  GatherCaps,
  GatherProgressEvent,
} from '../types.js';
import type { BootstrapState } from './bootstrap-state.js';
import type { Wave1Output } from './wave-types.js';
import { truncate } from './helpers.js';

/**
 * Wave 1 — runs the keyword-generator AND (taskId path only) one
 * cluster-analyst per cluster in parallel.
 *
 * Keyword-generator scope: task-mode includes title + body (≤2000
 * chars) + first 5 comments (≤200 chars each); question-mode just
 * the question text.
 *
 * Cluster-analyst scopes: one per cluster the task belongs to,
 * each containing the task's title + Mo summary + the cluster's
 * top-30 sibling notes (by confidence DESC, excluding the task
 * itself, excluding Mo's `mo:*` system notes). Empty-cluster
 * scopes (noteIds.length === 0) are skipped — the parallel
 * `clusterScopeIds` array preserves the 1:1 alignment with
 * `clusterScopes` so post-batch indexing can't drift onto the wrong
 * cluster id (regression 01KR5FBYS9QRM60BMX54DR1XZR).
 *
 * Best-effort: when the keyword-generator fails the wave falls back
 * to `bootstrap.metadataKeywords`; when individual cluster-analysts
 * fail they're surfaced as warnings without aborting the wave.
 */
export async function runWave1(
  input: GatherInput,
  bootstrap: BootstrapState,
  deps: GatherDeps,
  caps: GatherCaps,
  emit: (e: GatherProgressEvent) => void,
): Promise<Wave1Output> {
  const moCtx = toMoInternalCtx(deps.ctx);
  const subagentDeps = {
    provider: deps.provider,
    model: deps.subagentModel,
    budget: deps.budget,
    // Deep-research reads bill to `mo_gather`, not the legacy
    // `mo_tool` (Slice 2 of ticket 01KRJSTN74FT7VRX6KAA42GGBS).
    // Lets the Usage dashboard put mo_get_context / mo_ask spend in
    // the Interactive bucket beside chat instead of mixing it with
    // mo_record / mo_remember writes.
    spendKind: 'mo_gather' as const,
  };

  // Build keyword-generator scope.
  const keywordScope = input.taskId
    ? `# Task title\n${bootstrap.taskTitle ?? '(untitled)'}\n\n# Task body\n${truncate(bootstrap.taskBody ?? '', 2000)}\n\n# Recent comments\n${bootstrap.comments
        .slice(0, 5)
        .map((c) => `- ${c.actor}: ${truncate(c.body, 200)}`)
        .join('\n')}`
    : `# Question\n${input.question ?? ''}`;

  // Build cluster-analyst scopes (taskId path only). Parallel arrays:
  // `clusterScopes` holds the prompt scope per cluster, `clusterScopeIds`
  // mirrors the cluster id for each surviving scope. Earlier code read
  // `bootstrap.clusterIds[i]` post-batch, which silently misattributed
  // findings when ANY cluster was skipped (noteIds.length===0
  // `continue`'d the scope push, shifting later cluster ids onto the
  // wrong result row). Same shape as the Wave 2 crash; pin both fixes
  // together so future filters can't drift index either way.
  const clusterScopes: Array<{ scope: string; folderId?: string | null }> = [];
  const clusterScopeIds: string[] = [];
  if (input.taskId && bootstrap.folderId && bootstrap.clusterIds.length > 0) {
    for (const clusterId of bootstrap.clusterIds) {
      // Pull the cluster's task metas via Mo's elevated ctx.
      interface Row {
        note_id: string;
      }
      const noteIds = moCtx.db
        .prepare<[string, string, string], Row>(
          `SELECT c.note_id FROM note_mo_clusters c
             JOIN notes n ON n.id = c.note_id
            WHERE c.cluster_id = ?
              AND n.folder_id = ?
              AND n.deleted_at IS NULL
              AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
              AND n.id != ?
            ORDER BY c.confidence DESC
            LIMIT 30`,
        )
        .all(clusterId, bootstrap.folderId, input.taskId)
        .map((r) => r.note_id);
      if (noteIds.length === 0) continue;
      const metaByNoteId =
        moCtx.concierge?.moMetadata?.getMany(noteIds) ?? new Map();
      const taskLines = noteIds.flatMap((id) => {
        const note = moCtx.notes.getById(id);
        if (!note) return [];
        const meta = metaByNoteId.get(id);
        return [
          `- [${id}] ${note.title}${meta?.summary ? ` — ${truncate(meta.summary, 200)}` : ''}`,
        ];
      });
      const scope = [
        `# Agent's task`,
        `Title: ${bootstrap.taskTitle ?? '(untitled)'}`,
        `Summary: ${bootstrap.metadataSummary ?? '(no summary)'}`,
        ``,
        `# Cluster: \`${clusterId}\``,
        `Notes in this cluster (id + title + summary):`,
        ...taskLines,
      ].join('\n');
      clusterScopes.push({ scope, folderId: bootstrap.folderId });
      clusterScopeIds.push(clusterId);
    }
  }

  emit({
    kind: 'wave_start',
    wave: 1,
    subMoCount: 1 + clusterScopes.length,
  });

  // Run keyword-generator.
  const keywordResult = await runSubMoTask(
    subagentDeps,
    keywordGeneratorRole,
    keywordScope,
    { folderId: input.folderId ?? null },
  );

  // Run cluster-analysts in parallel.
  const clusterBatch =
    clusterScopes.length > 0
      ? await runSubMoBatch(subagentDeps, taskClusterAnalystRole, clusterScopes, {
          concurrency: caps.subagentConcurrency,
        })
      : null;

  const warnings: string[] = [];
  let keywords: string[] = [];
  if (keywordResult.ok) {
    keywords = keywordResult.data.keywords;
  } else {
    warnings.push(`keyword-generator failed: ${keywordResult.reason}`);
    keywords = bootstrap.metadataKeywords;
  }

  const clusterFindings: Wave1Output['clusterFindings'] = [];
  if (clusterBatch) {
    for (let i = 0; i < clusterBatch.results.length; i++) {
      const result = clusterBatch.results[i]!;
      // Use the parallel `clusterScopeIds` (built in lock-step with
      // `clusterScopes`) instead of `bootstrap.clusterIds[i]` — the
      // latter drifts when a cluster's noteIds were empty and got
      // skipped above. Bug 01KR5FBYS9QRM60BMX54DR1XZR.
      const clusterId = clusterScopeIds[i]!;
      if (result.ok) {
        clusterFindings.push({
          clusterId,
          drillIntoNoteIds: result.data.drillIntoNoteIds,
          why: result.data.why,
        });
      } else {
        warnings.push(
          `cluster-analyst on \`${clusterId}\` failed: ${result.reason}`,
        );
      }
    }
  }

  const spentUsd =
    keywordResult.costUsd + (clusterBatch?.totalCostUsd ?? 0);

  emit({
    kind: 'wave_complete',
    wave: 1,
    okCount:
      (keywordResult.ok ? 1 : 0) + (clusterBatch?.okCount ?? 0),
    failedCount:
      (keywordResult.ok ? 0 : 1) + (clusterBatch?.failedCount ?? 0),
    spentUsd,
  });

  return { keywords, clusterFindings, spentUsd, warnings };
}
