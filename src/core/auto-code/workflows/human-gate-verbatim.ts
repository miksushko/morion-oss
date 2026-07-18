/**
 * Verbatim human_gate plumbing — "Mo = router, not narrator" epic.
 *
 * The ask_human loop used to run the agent's question and the user's
 * reply through Mo twice — a double paraphrase that dropped the exact
 * details that made the question worth asking. These pure helpers let
 * the handler / resume path carry the ORIGINAL words: extract the
 * agent's `QUESTION:` block from its stage output, and concatenate the
 * user's own chat messages verbatim. Mo becomes a courier (which
 * branch, a one-line preamble), never the author of the content.
 */

/**
 * Pull the agent's question out of its final stage output. The fix
 * prompts instruct agents to end their turn with the question prefixed
 * by `QUESTION:` (case-insensitive; `Q:` accepted as a shorthand).
 * Returns the text AFTER the marker, verbatim (trimmed), or null when
 * no marker is present — in which case the caller falls back to Mo's
 * LLM composition.
 */
export function extractQuestionBlock(summary: string | null | undefined): string | null {
  if (typeof summary !== 'string' || summary.trim().length === 0) return null;
  // Match the LAST marker occurrence — agents sometimes restate the
  // question at the very end after some reasoning.
  const re = /(?:^|\n)\s*(?:QUESTION|Q)\s*:\s*/gi;
  let lastIdx = -1;
  let matchEnd = -1;
  for (let m = re.exec(summary); m !== null; m = re.exec(summary)) {
    lastIdx = m.index;
    matchEnd = re.lastIndex;
  }
  if (lastIdx === -1) return null;
  const block = summary.slice(matchEnd).trim();
  return block.length > 0 ? block : null;
}

/**
 * The user's own words across the gate window, verbatim. Given the
 * chat transcript for the human_gate session (which exists solely for
 * this pause), keep every `user` message in order and join them — no
 * summarization. This is what reaches the re-invoked agent as
 * `{{reopen.userReply}}` / folded into `{{reopen.reason}}`.
 */
export function collectVerbatimUserReply(
  chatHistory: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): string {
  return chatHistory
    .filter((m) => m.role === 'user' && m.content.trim().length > 0)
    .map((m) => m.content.trim())
    .join('\n\n');
}
