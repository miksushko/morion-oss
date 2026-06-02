import { z } from 'zod';

export const WorkflowEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** L4 will branch on labels (`success` / `failure` / `approve` / `reject`
   *  / branch outcomes). L2 ignores. */
  on: z.string().default('success'),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
