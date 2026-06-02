import { z } from 'zod';

/** Persisted canvas layout. Keyed by stable identifiers — stage ids
 *  for nodes, "<from>→<to>:<on>" tuples for edges — so the runtime
 *  doesn't care about coordinate drift (it walks stages + edges by
 *  id) but the editor restores the user's arrangement across saves.
 *
 *  The runner ignores `layout` entirely; it's pure render state.
 *  Missing entries fall back to dagre auto-layout at hydration. */
export const WorkflowLayoutSchema = z.object({
  nodes: z
    .record(
      z.string(),
      z.object({ x: z.number(), y: z.number() }),
    )
    .optional(),
  edges: z
    .record(
      z.string(),
      z.object({ cx: z.number(), cy: z.number() }),
    )
    .optional(),
});
export type WorkflowLayout = z.infer<typeof WorkflowLayoutSchema>;
