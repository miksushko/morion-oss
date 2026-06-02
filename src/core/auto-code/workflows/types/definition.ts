import { z } from 'zod';
import { WorkflowStageSchema } from './stages/index.js';
import { WorkflowEdgeSchema } from './edges.js';
import { WorkflowLayoutSchema } from './layout.js';
import { runDefinitionRefinements } from './refinements/index.js';

export const WorkflowDefinitionSchema = z
  .object({
    /** Schema version. Bump when wire shape changes incompatibly. */
    schemaVersion: z.literal(1).default(1),
    name: z.string().min(1),
    description: z.string().default(''),
    /** Linear in v1. Runner walks in array order, ignoring `edges`. */
    stages: z.array(WorkflowStageSchema).min(1),
    edges: z.array(WorkflowEdgeSchema).default([]),
    /** Optional canvas layout — user-arranged node positions + edge
     *  control points. Pure UI state; the runner ignores it. */
    layout: WorkflowLayoutSchema.optional(),
  })
  .superRefine((def, ctx) => {
    runDefinitionRefinements(def, ctx);
  });
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
