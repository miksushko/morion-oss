import { z } from 'zod';
import type { RefinementCtx, RefinementDef } from './types.js';

/** Stage ids must be unique within a snapshot — `current_stage_id`,
 *  `stage_id_in_graph`, `latestAttemptForStage()`, and Mustache references
 *  like `{{stages.fix.output}}` all resolve by id. A duplicate id silently
 *  collapses retry bookkeeping onto the wrong row. */
export function checkUniqueStageIds(def: RefinementDef, ctx: RefinementCtx): void {
  const seen = new Set<string>();
  def.stages.forEach((stage, idx) => {
    if (seen.has(stage.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stages', idx, 'id'],
        message: `duplicate stage id "${stage.id}" — stage ids must be unique within a workflow definition`,
      });
    }
    seen.add(stage.id);
  });
}

/** Edges must reference existing stage ids on both endpoints. L4 will
 *  walk these to compute traversal; a typo today silently breaks routing
 *  tomorrow. */
export function checkEdgeEndpoints(def: RefinementDef, ctx: RefinementCtx): void {
  const stageIds = new Set(def.stages.map((s) => s.id));
  def.edges.forEach((edge, idx) => {
    if (!stageIds.has(edge.from)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['edges', idx, 'from'],
        message: `edge.from "${edge.from}" does not match any stage id`,
      });
    }
    if (!stageIds.has(edge.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['edges', idx, 'to'],
        message: `edge.to "${edge.to}" does not match any stage id`,
      });
    }
  });
}
