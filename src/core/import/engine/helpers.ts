/**
 * Format-agnostic helpers for the import engine. Extracted from
 * `../engine.ts` so the orchestrator stays focused on lifecycle.
 *
 * Pure functions — no engine state, no DB access.
 */

/**
 * Drain `items` via `worker` with at most `limit` concurrent calls.
 * Returns when every item has settled. `shouldCancel()` is checked
 * before each new dispatch — already-dispatched workers complete.
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  shouldCancel: () => boolean,
): Promise<void> {
  let cursor = 0;
  const runners: Promise<void>[] = [];

  const launchOne = async (): Promise<void> => {
    while (cursor < items.length) {
      if (shouldCancel()) return;
      const idx = cursor++;
      const item = items[idx];
      if (item === undefined) return;
      await worker(item);
      // Yield to the event loop after each file so the SSE bridge's
      // fire-and-forget `writeSSE` calls have a chance to flush to
      // the network before the next file emits its `progress` event.
      // Without this, the worker loop never returns control between
      // files (better-sqlite3 is sync; in-memory body processing is
      // sync) and 50-file imports arrive at the browser as one
      // coalesced TCP chunk → React renders 0% → 100%, no
      // intermediate progress visible (ticket 01KQFG6926C70KC3TM6CAD2APQ).
      // setImmediate (vs setTimeout(0) / queueMicrotask) runs after
      // I/O callbacks, so the writeSSE promise chain — which lives
      // on the I/O queue — completes before the next file claims a
      // turn. Sub-microsecond overhead per file in practice.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  const cap = Math.min(limit, items.length);
  for (let i = 0; i < cap; i++) {
    runners.push(launchOne());
  }
  await Promise.all(runners);
}

/**
 * Make sure `body` starts with an H1 matching `title`. If body already
 * starts with a matching H1 we keep it. If body is empty, just emit
 * the title. Otherwise prepend `# title\n\n`.
 *
 * This mirrors `NotesRepository.create`'s legacy title-merging logic
 * but keeps it explicit at the import layer so the file-on-disk title
 * derivation stays a clean concept.
 */
export function ensureTitlePrefix(body: string, title: string): string {
  const trimmedBody = body.trimStart();
  if (trimmedBody.length === 0) return title;
  // Check if the first non-blank line already is an H1 with this title.
  const firstLine = trimmedBody.split(/\r?\n/, 1)[0] ?? '';
  if (/^#\s+/.test(firstLine)) {
    const existing = firstLine.replace(/^#\s+/, '').trim();
    if (existing === title) return body;
  }
  return `# ${title}\n\n${body}`;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Count whitespace-separated tokens. Markdown formatting (headings,
 * emphasis, links) doesn't artificially inflate the count — `**bold**`
 * is one word, `[link](url)` counts as `[link](url)` one token.
 * Language-agnostic; CJK text without spaces will undercount, but
 * for English/Russian/most Latin-script content the heuristic is solid.
 */
export function countWords(s: string): number {
  if (!s) return 0;
  const trimmed = s.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}
