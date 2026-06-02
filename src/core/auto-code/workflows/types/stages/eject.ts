import { z } from 'zod';

/** Terminal "eject" sink. Wired as the target of one or more
 *  edges; when the runner reaches this stage the run ends
 *  with `status='cancelled'` + `lastError=reason`. Has only
 *  an inbound handle visually — no outputs. Useful as the
 *  explicit destination of a `mo_router`'s "abort" branch or
 *  a reviewer's "escalate" path.
 *
 *  Runtime support arrives with the DAG runner; the editor
 *  accepts the stage today so flows can be drafted. */
export const EjectStageSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('eject'),
  reason: z.string().default('Ejected by workflow'),
});
