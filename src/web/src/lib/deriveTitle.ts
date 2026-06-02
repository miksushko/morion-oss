/**
 * Derive a display title from the first non-empty line of a note body.
 *
 * Rules:
 * 1. Skip leading blank lines.
 * 2. Strip leading markdown markers: `#`..`######`, `-`, `*`, `+`, `1.`, `>`.
 * 3. Trim whitespace.
 * 4. Truncate to 100 characters without cutting mid-word (if possible).
 * 5. Return '' if the body is entirely empty/whitespace.
 *
 * Duplicated from src/core/notes/title.ts so the web bundle stays within the
 * architecture boundary (src/web must not import src/core directly).
 */
export function deriveTitleFromBody(body: string): string {
  const lines = body.split('\n');
  let raw = '';
  for (const line of lines) {
    if (line.trim()) {
      raw = line;
      break;
    }
  }
  if (!raw.trim()) return '';

  // Strip leading markdown block markers
  let stripped = raw.trim();
  // Headings: # … ######
  stripped = stripped.replace(/^#{1,6}\s+/, '');
  // Blockquote
  stripped = stripped.replace(/^>\s+/, '');
  // Unordered list markers: -, *, +
  stripped = stripped.replace(/^[-*+]\s+/, '');
  // Ordered list: 1. 2. etc.
  stripped = stripped.replace(/^\d+\.\s+/, '');
  // Task list checkbox: - [ ] or - [x]
  stripped = stripped.replace(/^\[[ xX]\]\s*/, '');

  stripped = stripped.trim();
  if (!stripped) return '';

  if (stripped.length <= 100) return stripped;

  // Truncate at the last space before char 100 to avoid mid-word cuts
  const cut = stripped.lastIndexOf(' ', 100);
  if (cut > 20) return stripped.slice(0, cut).trimEnd();
  // No good break point — hard cut at 100
  return stripped.slice(0, 100).trimEnd();
}
