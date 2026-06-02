import { z } from 'zod';

/** Terminal "reject" sink. The run ends with the ticket moved to backlog
 *  and a Mo comment posted explaining why. Edges may target it from any
 *  Mo decision stage. Always present on every workflow canvas — can't
 *  be deleted by the user.
 *
 *  Runtime support arrives with the DAG runner. */
export const RejectSinkStageSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('reject_sink'),
  /** Optional template for the rejection comment Mo posts. When omitted
   *  Mo composes a generic "ejected by workflow: <reason>" comment. */
  commentTemplate: z.string().default(''),
});

/** Terminal "complete" sink. The run ends with the ticket moved to done
 *  and a Mo comment posted summarising the work. Always present on every
 *  workflow canvas — can't be deleted by the user. */
export const CompleteSinkStageSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('complete_sink'),
  /** Optional template for the closing comment. When omitted Mo composes
   *  a summary from the last stage output. */
  commentTemplate: z.string().default(''),
});
