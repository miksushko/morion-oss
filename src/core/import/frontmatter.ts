import matter from 'gray-matter';

/**
 * YAML frontmatter parser for Phase 2 markdown imports.
 *
 * Wraps `gray-matter` (already a dep — used by the legacy
 * `MarkdownImporter`). Extracts the fields we care about and returns
 * the body with the frontmatter block stripped.
 *
 * Recognised fields:
 *   - `title` (string) → note title; falls back to first H1 / filename
 *     in the engine layer when absent.
 *   - `tags` (array or comma-separated string) → note tags. Trimmed,
 *     deduplicated, lowercase preserved as-is so Obsidian's #Camel
 *     vs Morion's lowercased tags don't silently merge.
 *   - `created` / `date` (ISO 8601 / Date) → epoch ms; engine uses it
 *     to override `notes.created_at`. When absent, falls back to file
 *     mtime.
 *   - `aliases` — captured but currently unused. Phase 2.5 may push
 *     them to keywords.
 *
 * The `body` returned has the frontmatter delimiter block removed.
 * Fenced front-matter (```yaml ... ```) is NOT parsed — only the
 * canonical `---\n…\n---` form Obsidian / Hugo / Jekyll all use.
 *
 * Malformed YAML doesn't throw — the file is treated as having no
 * frontmatter, body returned verbatim. Reason: a half-broken metadata
 * block is the user's data, we should not refuse to import it.
 */

export interface ParsedFrontmatter {
  title: string | null;
  tags: string[];
  /** Epoch ms; null when no `created` / `date` field present. */
  createdAt: number | null;
  /** Captured for future use; ignored by the engine in Phase 2. */
  aliases: string[];
  /** Body with the frontmatter block stripped. */
  body: string;
  /** Whether a frontmatter block was actually detected and parsed. */
  hadFrontmatter: boolean;
}

const TAG_DELIMITER = /[, \t]+/;

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  // gray-matter is forgiving on malformed YAML — it returns the whole
  // input as `content` with empty `data`. We still wrap in try/catch
  // because the lib has thrown in pathological cases historically.
  let data: Record<string, unknown> = {};
  let body = raw;
  let hadFrontmatter = false;
  try {
    const parsed = matter(raw);
    data = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content;
    hadFrontmatter = Object.keys(data).length > 0;
  } catch {
    // Malformed YAML — treat as no frontmatter, ship the body verbatim.
    return {
      title: null,
      tags: [],
      createdAt: null,
      aliases: [],
      body: raw,
      hadFrontmatter: false,
    };
  }

  return {
    title: extractString(data.title),
    tags: extractTags(data.tags),
    createdAt: extractDate(data.created ?? data.date),
    aliases: extractStringList(data.aliases),
    // Strip ONLY leading newlines (the blank line(s) gray-matter leaves
    // after the closing `---`), not all leading whitespace. Markdown
    // treats indented lines specially (lists, code blocks), so a
    // line starting with spaces is meaningful content we shouldn't trim.
    body: body.replace(/^\n+/, ''),
    hadFrontmatter,
  };
}

function extractString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractTags(v: unknown): string[] {
  if (Array.isArray(v)) {
    const out = v
      .filter((t): t is string | number => typeof t === 'string' || typeof t === 'number')
      .map((t) => String(t).trim())
      .filter((t) => t.length > 0);
    return dedup(out);
  }
  if (typeof v === 'string') {
    const out = v.split(TAG_DELIMITER).map((t) => t.trim()).filter((t) => t.length > 0);
    return dedup(out);
  }
  return [];
}

function extractStringList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (typeof v === 'string') {
    return [v.trim()].filter((s) => s.length > 0);
  }
  return [];
}

function extractDate(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) {
    const ms = v.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof v === 'number') {
    // Heuristic: epoch seconds vs ms. Anything < year 2100 in seconds
    // is < 4.1e9; in ms it's > 4e12. Boundary at 1e12.
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function dedup(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const lower = item.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(item);
  }
  return out;
}
