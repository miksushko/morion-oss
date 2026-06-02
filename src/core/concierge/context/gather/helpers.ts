import type { GatherDeps } from '../types.js';

/** Truncate long bodies / summaries when building sub-Mo prompts.
 *  Appends an ellipsis when content was clipped so the sub-Mo can
 *  see that the input was abbreviated. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

/** Embed text via the workspace embedder, swallowing any failure so
 *  the gather pipeline can degrade gracefully (semantic cache lookup
 *  + question-side cache writes become no-ops if the embedder is
 *  missing OR throws). */
export async function safeEmbed(
  embedder: NonNullable<GatherDeps['ctx']['embeddings']>,
  text: string,
): Promise<Float32Array | null> {
  try {
    return await embedder.embed(text, 'query');
  } catch {
    return null;
  }
}
