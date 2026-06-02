import { z } from 'zod';

/** Mo-driven router stage. The user authors a free-form
 *  instruction (`prompt`) describing how Mo should decide
 *  which output branch to route the ticket through; `branches`
 *  enumerates the legal next-stage labels. At runtime Mo reads
 *  the ticket + the instruction + the branches list, picks one,
 *  and the runner advances along the matching outbound edge.
 *
 *  Visually each branch becomes its own labelled source handle
 *  in the canvas. Runtime support depends on the DAG runner
 *  (currently L4 follow-up); `parseLinearWorkflow` rejects
 *  mo_router stages until then. */
export const MoRouterStageSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('mo_router'),
  prompt: z.string().default(''),
  branches: z.array(z.string().min(1)).default([]),
});
