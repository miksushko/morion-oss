/**
 * Text-snippet helpers for the concierge route family — used by session
 * search hit rendering. Extracted from `../shared.ts` (2026-05-16,
 * ticket `01KRQYS1T925XEWBBJJYRJBGE2`).
 */

/**
 * Build a short snippet from a message body that includes the
 * matched query substring with surrounding context. Used by
 * /sessions/search to render hit previews.
 *
 * Why server-side: the snippet is what the search UI shows under the
 * matching session title. Trimming on the server keeps the response
 * payload small (full message body could be many kB). The UI does a
 * second pass to bold the matched substring, but that's a render-time
 * concern, not a transport concern.
 */
export function extractMatchSnippet(body: string, query: string): string {
  const SNIPPET_RADIUS = 40;
  const SNIPPET_MAX = 120;
  const lower = body.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) {
    return body.length > SNIPPET_MAX ? `${body.slice(0, SNIPPET_MAX)}…` : body;
  }
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(body.length, idx + query.length + SNIPPET_RADIUS);
  const slice = body.slice(start, end).replace(/\s+/g, ' ').trim();
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return `${prefix}${slice}${suffix}`;
}

export function truncatePreview(s: string): string {
  const short = s.slice(0, 80);
  return s.length > short.length ? `${short}…` : short;
}
