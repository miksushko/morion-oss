import { z } from 'zod';
import type { RefinementCtx, RefinementDef } from './types.js';

/** human_gate single-output check (Editor Model v2 spec refined
 *  2026-05-11). Human Loop has exactly one inbound + one outbound
 *  edge — it's a side-attached text dialog, not a routing node.
 *  The user writes free text; Mo on the downstream stage reads
 *  the reply and picks the actual branch. Enforce exactly one
 *  outbound edge per human_gate so a typo can't route the run
 *  to nothing. */
export function checkHumanGateSingleOut(def: RefinementDef, ctx: RefinementCtx): void {
  def.stages.forEach((stage, stageIdx) => {
    if (stage.kind !== 'human_gate') return;
    const outboundCount = def.edges.filter((e) => e.from === stage.id).length;
    if (outboundCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stages', stageIdx],
        message: `human_gate "${stage.id}" has no outbound edge — the user's reply needs somewhere to go (typically back to the Mo stage that asked the question)`,
      });
    } else if (outboundCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stages', stageIdx],
        message: `human_gate "${stage.id}" has ${outboundCount} outbound edges — Human In The Loop is single-in / single-out by spec (Morion note 01KRAQWPXR5AYTFVF6J12TYHJ1). Route through a downstream Mo stage if you need multiple outcomes`,
      });
    }
  });
}

/** For every mo_stage / mo_router decision node, outbound edge.on
 *  labels must match the stage's declared branches (and vice versa
 *  for stages whose branches list non-empty values). Without this
 *  Mo picks a legal branch but the graph has no edge to follow, or
 *  an edge with a label Mo will never emit silently shadows real
 *  routing. Applies to legacy mo_router too (deprecated alias) so
 *  existing canvas drafts stay valid.
 *
 *  Per-branch alignment was strict ("every declared branch MUST
 *  have one outbound edge") which blocked mid-edit saves when the
 *  user added a branch label before wiring it. User feedback
 *  2026-05-11: relax to "no duplicates + no extra labels" so saving
 *  a partially-wired graph is allowed; the workflow-level
 *  terminal-reachability check still ensures SOMETHING in the
 *  graph reaches Complete / Reject. */
export function checkDecisionEdgeAlignment(def: RefinementDef, ctx: RefinementCtx): void {
  def.stages.forEach((stage, stageIdx) => {
    // Multi-out routing stages: mo_stage / mo_router decide via Mo's
    // `branches`. human_gate is single-out (separate block above).
    let declared: Set<string>;
    let labelsPath: (string | number)[];
    if (stage.kind === 'mo_stage' || stage.kind === 'mo_router') {
      declared = new Set(stage.branches);
      labelsPath = ['stages', stageIdx, 'branches'];
    } else {
      return;
    }
    if (declared.size === 0) return;
    const outboundCounts = new Map<string, number>();
    const outboundEdgeIndices: number[] = [];
    def.edges.forEach((edge, edgeIdx) => {
      if (edge.from !== stage.id) return;
      outboundEdgeIndices.push(edgeIdx);
      outboundCounts.set(edge.on, (outboundCounts.get(edge.on) ?? 0) + 1);
    });
    // (i) Reject edge labels that aren't declared (a typo would
    // route to a label the user can never pick).
    outboundEdgeIndices.forEach((edgeIdx) => {
      const label = def.edges[edgeIdx]!.on;
      if (!declared.has(label)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', edgeIdx, 'on'],
          message: `outbound edge.on "${label}" from "${stage.id}" is not a declared branch (branches: ${[...declared].map((b) => `"${b}"`).join(', ')})`,
        });
      }
    });
    // (ii) At most one outbound edge per label (duplicate routes
    // are ambiguous). Unconnected branches are ALLOWED — the
    // workflow-level reachability check below catches graphs
    // with no path to terminals.
    declared.forEach((label) => {
      const count = outboundCounts.get(label) ?? 0;
      if (count > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: labelsPath,
          message: `"${stage.id}" has ${count} outbound edges with on="${label}" — at most one outbound edge per branch so routing stays deterministic`,
        });
      }
    });
  });
}
