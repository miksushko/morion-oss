/**
 * Derive a display title from the first non-empty line of a note body.
 *
 * Rules:
 * 1. Skip leading blank lines.
 * 2. Strip leading markdown markers: `#`..`######`, `-`, `*`, `+`, `1.`, `>`.
 * 3. Trim whitespace.
 * 4. Truncate to 100 characters without cutting mid-word (if possible).
 * 5. Return '' if the body is entirely empty/whitespace.
 */
/**
 * Hard cap on how much of `body` we scan to find the first non-empty line.
 * Title can't be longer than 100 chars and we only need a handful of leading
 * blank lines to skip, so 8 KB is plenty for any legitimate input. Anything
 * past this is noise — for a pathological 100 MB body (e.g. an MCP client
 * dumping a pasted transcript), `body.split('\n')` would materialise the
 * entire file as an array in memory, making title derivation an O(n) OOM
 * risk (audit N22, 2026-04-16). The cap makes it O(1).
 */
const TITLE_SCAN_LIMIT = 8 * 1024;

/**
 * Matches a markdown image `![alt](url)`. Used both to detect image-only
 * lines (full anchor to end-of-line) and to strip leading inline images
 * from a prose line. `[^\]]*` for the alt and `[^)]+` for the URL are
 * intentionally simple — the url never contains `)` because the markdown
 * spec uses `\)` escaping, which isn't emitted by our Tiptap serializer.
 */
const IMAGE_ONLY_LINE = /^!\[([^\]]*)\]\([^)]+\)\s*$/;
const LEADING_IMAGE = /^!\[[^\]]*\]\([^)]+\)\s*/;

export function deriveTitleFromBody(body: string): string {
  // Only look at the first 8 KB — that's enough to find the title line in
  // any real note. Splitting the full body was an unbounded O(n) memory
  // allocation when called from MCP on a multi-megabyte body.
  const head = body.length > TITLE_SCAN_LIMIT ? body.slice(0, TITLE_SCAN_LIMIT) : body;
  const lines = head.split('\n');

  // Direction P (inline images). Walk lines looking for the first
  // non-blank line that's NOT a bare image. A `![alt](url)` line on its
  // own produces a title of the alt text, or — if alt is empty — falls
  // through to the next line. Without this, pasting an image as the
  // first line of an empty note produced a "Title" of
  // `![screenshot](morion://attachment/01K…)` or worse.
  let raw = '';
  let altFromImage: string | null = null;
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    const imageOnly = IMAGE_ONLY_LINE.exec(trimmedLine);
    if (imageOnly) {
      const alt = imageOnly[1].trim();
      if (alt) {
        altFromImage = alt;
        break;
      }
      // Empty alt — keep scanning. Typical for paste-from-clipboard
      // where the browser doesn't supply a filename.
      continue;
    }
    raw = line;
    break;
  }
  if (altFromImage) {
    return clampTitleLength(altFromImage);
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
  // Leading inline image: `![chart](…) Q3 revenue` → `Q3 revenue`. If
  // the entire line was an inline image followed by nothing (shouldn't
  // happen — image-only lines match IMAGE_ONLY_LINE above — but a
  // pathological heading like `# ![x](y)` would land here) the result
  // trims to empty and the title falls back to ''.
  stripped = stripped.replace(LEADING_IMAGE, '');

  stripped = stripped.trim();
  if (!stripped) return '';

  return clampTitleLength(stripped);
}

function clampTitleLength(title: string): string {
  if (title.length <= 100) return title;
  // Truncate at the last space before char 100 to avoid mid-word cuts
  const cut = title.lastIndexOf(' ', 100);
  if (cut > 20) return title.slice(0, cut).trimEnd();
  // No good break point — hard cut at 100
  return title.slice(0, 100).trimEnd();
}
