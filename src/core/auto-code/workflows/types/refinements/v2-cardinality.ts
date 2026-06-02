import { z } from 'zod';
import type { StageKind } from '../stage-kind.js';
import type { RefinementCtx, RefinementDef } from './types.js';

const V2_KINDS: ReadonlySet<StageKind> = new Set([
  'mo_stage',
  'reject_sink',
  'complete_sink',
]);

/** Editor Model v2 invariants (spec 01KRAQWPXR5AYTFVF6J12TYHJ1).
 *
 *  The v2 graph contract introduces three new stage kinds — `mo_stage`,
 *  `reject_sink`, `complete_sink` — with structural rules the editor
 *  pins visually but the schema must enforce to catch hand-edited JSON
 *  / API misuse. Returns true when the definition is a v2 graph so the
 *  caller can chain v2-only checks (reachability). */
export function hasV2Stage(def: RefinementDef): boolean {
  return def.stages.some((s) => V2_KINDS.has(s.kind));
}

/** Cardinality rules (only fire on v2 graphs, since legacy linear
 *  cli_agent / mcp_tool_call workflows have no sinks and no mo_stage):
 *    (a) Exactly one mo_stage with isStart=true.
 *    (b) Exactly one reject_sink and one complete_sink. */
export function checkV2Cardinality(def: RefinementDef, ctx: RefinementCtx): void {
  if (!hasV2Stage(def)) return;

  const startStages = def.stages.filter(
    (s) => s.kind === 'mo_stage' && s.isStart === true,
  );
  if (startStages.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stages'],
      message:
        'v2 workflow needs exactly one mo_stage with isStart=true (the "Process Start Step" entry node) — got 0',
    });
  } else if (startStages.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stages'],
      message: `v2 workflow needs exactly one mo_stage with isStart=true — got ${startStages.length} (${startStages.map((s) => `"${s.id}"`).join(', ')})`,
    });
  }

  const rejectSinks = def.stages.filter((s) => s.kind === 'reject_sink');
  const completeSinks = def.stages.filter((s) => s.kind === 'complete_sink');
  if (rejectSinks.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stages'],
      message: `v2 workflow needs exactly one reject_sink — got ${rejectSinks.length}`,
    });
  }
  if (completeSinks.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stages'],
      message: `v2 workflow needs exactly one complete_sink — got ${completeSinks.length}`,
    });
  }
}

/** Terminal sinks have no outbound edges. Reaching a sink ends
 *  the run by definition; an edge out is a contradiction the
 *  runtime can't honor. Applied UNCONDITIONALLY so the legacy
 *  `eject` alias also gets the check — a v1 canvas saved via
 *  the draft-path with eject + an accidental outbound edge
 *  would otherwise pass schema validation only to fail at
 *  dispatch. */
export function checkSinksHaveNoOutbound(def: RefinementDef, ctx: RefinementCtx): void {
  const sinkIds = new Set(
    def.stages
      .filter(
        (s) =>
          s.kind === 'reject_sink' ||
          s.kind === 'complete_sink' ||
          s.kind === 'eject',
      )
      .map((s) => s.id),
  );
  def.edges.forEach((edge, edgeIdx) => {
    if (sinkIds.has(edge.from)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['edges', edgeIdx, 'from'],
        message: `edge.from "${edge.from}" originates at a terminal sink — sinks (reject_sink / complete_sink / eject) cannot have outbound edges`,
      });
    }
  });
}
