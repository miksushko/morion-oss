/**
 * HTML sanitisation for imported markdown bodies.
 *
 * Tiptap is configured with `html: false`, so any raw HTML in a
 * stored body gets escaped at render time — that's the primary
 * defence. This sanitiser is **defence in depth**: removes the
 * dangerous tokens at ingest so even if a future setting flips
 * Tiptap to `html: true`, or a tool reads the body as HTML
 * directly (e.g. exporting to PDF), nothing executable survives.
 *
 * Strategy: regex-based. We don't run a full HTML parser because:
 *   - the markdown body is mostly plain text — full parsing is overkill
 *   - parsers introduce their own attack surface (unsafe defaults)
 *   - the strip targets are narrow + well-known
 *
 * What we strip:
 *
 *   1. Whole elements (open + content + close): `<script>`, `<iframe>`,
 *      `<object>`, `<embed>`, `<form>`, `<input>`, `<button>`,
 *      `<style>`, `<link>`, `<meta>`. Also self-closing variants.
 *   2. Event-handler attributes: anything starting with `on` (onclick,
 *      onmouseover, onerror, etc.). We don't enumerate; we strip every
 *      `on<word>="..."` / `on<word>='...'` regardless of which tag it's on.
 *   3. `javascript:` / `vbscript:` / `data:text/html` URIs in `href`,
 *      `src`, `formaction`, `action`. Replaced with `#blocked`.
 *   4. CSS expressions: `expression(...)` inside `style="..."` (legacy
 *      IE attack vector — paranoia + low-cost).
 *
 * What we KEEP:
 *
 *   - Standard markdown HTML: `<br>`, `<sub>`, `<sup>`, `<details>`,
 *     `<summary>`, `<ins>`, `<del>`, `<mark>`, `<kbd>`, `<abbr>`,
 *     `<cite>`, `<code>` — these compose with markdown and are safe
 *     when content can't include event handlers (we just stripped them).
 *   - HTML comments — they're inert in any rendering context except
 *     SSR injection, which we don't do.
 *   - Image / link tags survive (their hrefs / srcs go through the
 *     URI scheme strip above).
 *
 * Returns the sanitised body + a count of how many tokens were
 * removed. The count is informational — the engine logs it but
 * doesn't gate on it.
 */

export interface SanitizeResult {
  body: string;
  /** Total count of strip operations (whole-element + attribute combined). */
  removedCount: number;
}

const DANGEROUS_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'style',
  'link',
  'meta',
  'noscript',
  'frame',
  'frameset',
  'applet',
];

// Whole-element strip: opening tag through matching closing tag.
// `[\s\S]` for cross-line content (e.g. multi-line script blocks).
// Greedy match within one tag-pair is fine because we apply per-tag
// individually — no nested-tag confusion.
function buildTagStripRegex(tag: string): RegExp {
  return new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
}

// Self-closing / void variants (e.g. `<input ... />`, `<link href=... />`).
function buildSelfClosingTagStripRegex(tag: string): RegExp {
  return new RegExp(`<${tag}\\b[^>]*/?>`, 'gi');
}

// `on<word>="..."` / `on<word>='...'` / `on<word>=value`. Whitespace-
// tolerant. The trailing `[^\\s>]+` covers unquoted handler values.
const EVENT_HANDLER_ATTR = /\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

// Schemes we replace with `#blocked` when they appear as the value
// of href/src/action/formaction/xlink:href.
//   - `javascript:` and `vbscript:` — match scheme + colon directly.
//   - `data:text/html` — `data:` is the scheme; `text/html` is the
//     payload mime. Full URI is `data:text/html,<...>` (comma) or
//     `data:text/html;base64,<...>`. We strip the whole `data:text/html`
//     prefix regardless of what follows so the rendered href becomes
//     `#blocked:,<...>` (broken but inert).
const DANGEROUS_URI_SCHEMES =
  /\b(?:javascript\s*:|vbscript\s*:|data\s*:\s*text\s*\/\s*html\b)/gi;

// `style="... expression( ... ) ..."`. Replace the expression body
// with empty so the rest of the style stays intact.
const CSS_EXPRESSION = /expression\s*\([^)]*\)/gi;

export function sanitiseImportedHtml(input: string): SanitizeResult {
  // Split off markdown code regions BEFORE applying strip rules.
  // Fenced code blocks (```…```), indented code blocks, and inline
  // code spans (`…`) carry tag-shaped text that's NEVER executed
  // (markdown renderers escape them) — but our regex strips would
  // happily eat `<Button>` or `<style>` from a code sample,
  // mangling the user's content. We extract them, sanitize only
  // the prose between them, then restore.
  const segments = splitOutCodeRegions(input);
  let removedCount = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.kind !== 'prose') continue;
    const result = sanitizeProse(seg.text);
    segments[i] = { kind: 'prose', text: result.text };
    removedCount += result.removedCount;
  }
  return {
    body: segments.map((s) => s.text).join(''),
    removedCount,
  };
}

interface Segment {
  kind: 'prose' | 'code';
  text: string;
}

/**
 * Split a markdown document into prose / code segments. Code
 * regions (fenced ``` blocks AND inline `…` spans) are returned
 * verbatim; prose regions get sanitised separately.
 *
 * Order of recognition matters: fenced first (multi-line, eats
 * inline backticks inside), then inline. Indented code blocks
 * (4+ spaces at line start) are NOT recognised here because they
 * blur into normal markdown indentation patterns; relying on
 * Tiptap's html:false render is sufficient for those.
 */
function splitOutCodeRegions(input: string): Segment[] {
  const segments: Segment[] = [];
  // Combined pattern: fenced ```…``` OR inline `…`. Fenced wins
  // when both could match because alternation prefers the first
  // alternative on the same starting position.
  const re = /```[\s\S]*?```|`[^`\n]*`/g;
  let lastIndex = 0;
  let match;
  while ((match = re.exec(input)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'prose', text: input.slice(lastIndex, match.index) });
    }
    segments.push({ kind: 'code', text: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < input.length) {
    segments.push({ kind: 'prose', text: input.slice(lastIndex) });
  }
  return segments;
}

function sanitizeProse(input: string): { text: string; removedCount: number } {
  let removedCount = 0;
  let out = input;

  // 1. Whole-element strip for dangerous tags (paired form first,
  //    so `<script>...</script>` collapses before we hit the
  //    self-closing pattern — otherwise the closing tag remains).
  for (const tag of DANGEROUS_TAGS) {
    const paired = buildTagStripRegex(tag);
    out = out.replace(paired, () => {
      removedCount++;
      return '';
    });
    // Self-closing form for stragglers (e.g. `<input>` without close).
    const selfClosing = buildSelfClosingTagStripRegex(tag);
    out = out.replace(selfClosing, () => {
      removedCount++;
      return '';
    });
  }

  // 2. Event handlers on whatever tags remain.
  out = out.replace(EVENT_HANDLER_ATTR, () => {
    removedCount++;
    return '';
  });

  // 3. Dangerous URI schemes inside attribute values.
  out = out.replace(DANGEROUS_URI_SCHEMES, () => {
    removedCount++;
    return '#blocked:';
  });

  // 4. CSS expressions.
  out = out.replace(CSS_EXPRESSION, () => {
    removedCount++;
    return '';
  });

  return { text: out, removedCount };
}

/** Test-only re-export. */
export const __test = {
  DANGEROUS_TAGS,
  buildTagStripRegex,
  buildSelfClosingTagStripRegex,
};
