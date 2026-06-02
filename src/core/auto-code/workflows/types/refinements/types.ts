import type { z } from 'zod';
import type { WorkflowStage } from '../stages/index.js';
import type { WorkflowEdge } from '../edges.js';

/** Minimal shape the refinement helpers operate on. Mirrors the
 *  parsed shape produced by `WorkflowDefinitionSchema`'s base
 *  object before its superRefine runs. */
export interface RefinementDef {
  stages: WorkflowStage[];
  edges: WorkflowEdge[];
}

export type RefinementCtx = z.RefinementCtx;
