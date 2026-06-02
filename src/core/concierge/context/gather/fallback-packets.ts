import type { GatherInput, WorkContextPacket } from '../types.js';
import type { BootstrapState } from './bootstrap-state.js';

/** Markdown body for the fallback packet when synthesis fails or is
 *  skipped — surfaces raw bootstrap state so the caller still gets
 *  the task title / summary / cluster ids instead of an empty
 *  string. */
export function renderFallbackPacket(bootstrap: BootstrapState): string {
  const lines: string[] = ['# Mo context (synthesis unavailable)'];
  if (bootstrap.taskId) {
    lines.push('');
    lines.push(`Task: ${bootstrap.taskTitle ?? '(untitled)'} (${bootstrap.taskId})`);
    if (bootstrap.metadataSummary) {
      lines.push(`Summary: ${bootstrap.metadataSummary}`);
    }
    if (bootstrap.clusterIds.length > 0) {
      lines.push(`Clusters: ${bootstrap.clusterIds.join(', ')}`);
    }
  }
  lines.push('');
  lines.push('Synthesis step failed; raw bootstrap state surfaced instead. Try `force: true` on the next call to bypass cache.');
  return lines.join('\n');
}

/** Packet returned when the pre-flight budget gate refuses the call
 *  (or any other terminal pre-bootstrap rejection). Mostly zeroes —
 *  the bootstrap section reports no task / folder / clusters because
 *  none were read. */
export function emptyPacket(args: {
  mode: GatherInput['mode'];
  scope: 'folder' | 'workspace';
  capped: WorkContextPacket['capped'];
  warnings: string[];
}): WorkContextPacket {
  return {
    mode: args.mode,
    scope: args.scope,
    bootstrap: {
      taskId: null,
      folderId: null,
      clusterIds: [],
      commentCount: 0,
      auditCount: 0,
    },
    synthesizedMarkdown: '',
    citedNoteIds: [],
    risks: [],
    cacheHit: null,
    spentUsd: 0,
    capped: args.capped,
    warnings: args.warnings,
  };
}

/** Packet returned when a wave-budget cap fires BEFORE the synth
 *  step runs — bootstrap is filled in (the caller can still see what
 *  Mo found before the cap), but the markdown body falls back to
 *  the renderFallbackPacket shape. */
export function synthesisSkippedPacket(args: {
  mode: GatherInput['mode'];
  scope: 'folder' | 'workspace';
  bootstrap: BootstrapState;
  warnings: string[];
  capped: WorkContextPacket['capped'];
  spentUsd: number;
}): WorkContextPacket {
  return {
    mode: args.mode,
    scope: args.scope,
    bootstrap: {
      taskId: args.bootstrap.taskId,
      folderId: args.bootstrap.folderId,
      clusterIds: args.bootstrap.clusterIds,
      commentCount: args.bootstrap.comments.length,
      auditCount: args.bootstrap.audit.length,
    },
    synthesizedMarkdown: renderFallbackPacket(args.bootstrap),
    citedNoteIds: [],
    risks: [],
    cacheHit: null,
    spentUsd: args.spentUsd,
    capped: args.capped,
    warnings: args.warnings,
  };
}

/** Parse a cached packet's JSON blob and overlay the per-call
 *  metadata (mode / scope / cacheHit). On parse failure (corrupted
 *  cache row) returns a stub packet so the caller doesn't crash —
 *  the next call regenerates fresh. */
export function rehydrateCachedPacket(
  packetJson: string,
  overrides: Pick<WorkContextPacket, 'mode' | 'scope' | 'cacheHit'>,
): WorkContextPacket {
  let parsed: WorkContextPacket;
  try {
    parsed = JSON.parse(packetJson) as WorkContextPacket;
  } catch {
    // Cache row was corrupted — return a stub packet so the caller
    // doesn't crash. Next call regenerates fresh.
    return {
      mode: overrides.mode,
      scope: overrides.scope,
      bootstrap: {
        taskId: null,
        folderId: null,
        clusterIds: [],
        commentCount: 0,
        auditCount: 0,
      },
      synthesizedMarkdown: '',
      citedNoteIds: [],
      risks: [],
      cacheHit: overrides.cacheHit,
      spentUsd: 0,
      capped: null,
      warnings: ['cache row was unparseable; returning stub'],
    };
  }
  return { ...parsed, ...overrides, spentUsd: 0 };
}
