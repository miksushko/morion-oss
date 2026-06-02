/**
 * Render an audit/comments actor string as a human-readable name.
 *
 * Actor convention (mirrored from `audit_log.actor` / `note_comments.actor`):
 *   - `'user'`                 → UI origin                       → 'You'
 *   - `'mcp:<sanitized>'`      → MCP client that initialised     → mapped or title-cased
 *   - `'mcp:unknown'`          → MCP client that didn't self-id  → 'Unknown MCP client'
 *   - anything else            → returned verbatim (forward-compat)
 *
 * Known MCP clients get hand-curated display names. Unknown MCP clients
 * get title-cased from their slug (`mcp:my-custom-thing` → 'My Custom Thing').
 * The sanitization invariant from `src/server/mcp.ts` guarantees the
 * post-`mcp:` slug is `[a-zA-Z0-9_-]` up to 64 chars, so title-casing
 * by splitting on `-` / `_` is safe.
 *
 * Used by the activity panel, the revisions popover, and the audit log UI.
 * Keep the single source of truth here so a new MCP client shows up
 * identically across every surface.
 */

const KNOWN_MCP_CLIENTS: Record<string, string> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  'claude-ai': 'Claude',
  cursor: 'Cursor',
  cline: 'Cline',
  zed: 'Zed',
  windsurf: 'Windsurf',
  antigravity: 'Google Antigravity',
  codex: 'Codex',
  // Auto-code is Mo's auto-coding mode — Mo orchestrates the loop
  // per umbrella spec, the user-visible identity is just "Mo". The
  // distinct `mcp:auto-code` actor stays in the audit log for
  // forensic clarity (which sub-agent did what), but the UI shows
  // "Mo" so the kanban activity feed reads coherently.
  'auto-code': 'Mo',
  unknown: 'Unknown MCP client',
};

export function formatActor(actor: string): string {
  if (actor === 'user') return 'You';
  if (!actor.startsWith('mcp:')) return actor; // forward-compat: future actor types stay as-is

  const slug = actor.slice('mcp:'.length);
  const known = KNOWN_MCP_CLIENTS[slug];
  if (known) return known;

  // Title-case the sanitized slug: `my-custom-thing` → `My Custom Thing`.
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
