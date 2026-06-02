import { z } from 'zod';
import type { RefinementCtx, RefinementDef } from './types.js';
import { hasV2Stage } from './v2-cardinality.js';

/** Workflow-level terminal reachability (2026-05-11 user spec):
 *  "надо кидать ошибку, если невозможно дойти по цепочке до
 *  closed / reject состояний". Walk the graph from the Process
 *  Start mo_stage along def.edges; require AT LEAST one reachable
 *  complete_sink AND at least one reachable reject_sink. This
 *  replaces the strict per-branch rule — users can save
 *  partially-wired graphs as long as terminals are still in
 *  reach somewhere along the wired paths. */
export function checkTerminalReachability(def: RefinementDef, ctx: RefinementCtx): void {
  if (!hasV2Stage(def)) return;
  const startStage = def.stages.find(
    (s) => s.kind === 'mo_stage' && s.isStart === true,
  );
  if (!startStage) return;

  const adj = new Map<string, Set<string>>();
  for (const e of def.edges) {
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    adj.get(e.from)!.add(e.to);
  }
  const reachable = new Set<string>([startStage.id]);
  const queue: string[] = [startStage.id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const outs = adj.get(cur);
    if (!outs) continue;
    for (const t of outs) {
      if (reachable.has(t)) continue;
      reachable.add(t);
      queue.push(t);
    }
  }
  const reachesComplete = def.stages.some(
    (s) => s.kind === 'complete_sink' && reachable.has(s.id),
  );
  const reachesReject = def.stages.some(
    (s) => s.kind === 'reject_sink' && reachable.has(s.id),
  );
  if (!reachesComplete) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['edges'],
      message:
        'no path from the Process Start to a complete_sink — wire at least one branch chain that ends at Complete so the workflow can finish successfully',
    });
  }
  if (!reachesReject) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['edges'],
      message:
        'no path from the Process Start to a reject_sink — wire at least one branch chain that ends at Reject so Mo can bounce ineligible tickets',
    });
  }
}
