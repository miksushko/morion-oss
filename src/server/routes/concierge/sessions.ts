/**
 * Ask Mo chat sessions — basic CRUD + transcript fetch + search.
 *
 * - GET    /sessions                 — list (with needsHumanCount).
 * - POST   /sessions                 — create.
 * - GET    /sessions/search          — LIKE search over title + message bodies.
 * - GET    /sessions/:id             — get one.
 * - PATCH  /sessions/:id             — rename / archive / setNeedsHuman.
 * - DELETE /sessions/:id             — hard delete.
 * - GET    /sessions/:id/messages    — transcript (UI pagination).
 *
 * The chat dispatch / quick-action / tool-approve / tool-progress
 * routes live in a separate session-messages module (slice 11).
 *
 * IMPORTANT: `/sessions/search` MUST register BEFORE `/sessions/:id`
 * — Hono's trie matches the literal "search" before falling into
 * the `:id` capture. Reorder breaks the search route silently
 * (matches as `id="search"` → 404). Pinned by
 * `tests/concierge-route-registration.test.ts`.
 *
 * Extracted from `src/server/routes/concierge.ts` (slice 6/N of the
 * route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F). Pure code-
 * motion — behaviour unchanged.
 */

import type { Hono } from 'hono';
import type { ToolContext } from '../../tools/types.js';
import {
  createSessionSchema,
  sessionPatchSchema,
} from './schemas.js';
import { extractMatchSnippet, requireConciergeDeps } from './shared.js';

/** Accept the common boolean query forms (`1`, `true`) for opt-in
 *  flags. Matches `routes/folders.ts` and `routes/notes.ts`. Anything
 *  else — empty / missing / `0` / `false` / typos — is `false`.
 *  Previously this route only honoured `=1`; passing `=true` (the
 *  convention everywhere else in the API) silently filtered out
 *  archived rows and looked like a server bug to anyone debugging via
 *  DevTools or curl (Morion ticket 01KRPT4BQT18H8HVKGA3026WDD). */
function parseBooleanQuery(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

export function registerSessionsRoutes(app: Hono, ctx: ToolContext): void {
  app.get('/api/concierge/sessions', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const includeArchived = parseBooleanQuery(c.req.query('includeArchived'));
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
    return c.json({
      items: bag.bag.sessions.list({ limit, includeArchived }),
      needsHumanCount: bag.bag.sessions.countNeedsHuman(),
    });
  });

  app.post('/api/concierge/sessions', async (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const body = createSessionSchema.parse(await c.req.json().catch(() => ({})));
    const session = bag.bag.sessions.create({
      folderId: body.folderId ?? null,
      title: body.title ?? '',
      openedBy: 'user',
    });
    return c.json(session);
  });

  // ------- Chat search (Mo Chat ticket 01KQXVCB6XQCHZ84VPN4166FH7) ------
  // SQL LIKE over `concierge_sessions.title` AND `concierge_messages.content`,
  // case-insensitive via lowercasing both sides. We DON'T FTS-index
  // chat messages — typical chat volumes (10s of sessions × 10s of
  // messages) make LIKE fast enough, and an FTS5 trigger on
  // concierge_messages would double the write cost on every chat
  // turn for a feature only opened occasionally.
  //
  // Returns sessions ordered by `updated_at DESC`, deduped (a session
  // matched on both title and message body shows up once). Each hit
  // carries an optional `matchSnippet` excerpt — the first matching
  // 80-char window from the highest-scoring matching message —
  // surfaced under the title in the search popup. When the match was
  // title-only `matchSnippet` is null and the UI hides the snippet
  // line.
  //
  // Path is `/sessions/search` (NOT `/search/sessions`) so it sits
  // alongside the other `sessions/*` endpoints. Query string is
  // `?q=<term>` with at most 50 results (`limit` query override
  // capped at 100).
  app.get('/api/concierge/sessions/search', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const q = (c.req.query('q') ?? '').trim();
    if (q.length === 0) {
      return c.json({ items: [], query: '' });
    }
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 100);
    const includeArchived = parseBooleanQuery(c.req.query('includeArchived'));
    // Wrap the user's query in `%...%` for LIKE; lower() both sides
    // for case-insensitive match. SQLite's LIKE is case-insensitive
    // for ASCII by default but we use lower()+LIKE explicitly so
    // Cyrillic / mixed-case titles work too.
    const pattern = `%${q.toLowerCase()}%`;
    const archiveClause = includeArchived ? '' : 'AND s.archived_at IS NULL';
    interface SessionRow {
      id: string;
      folder_id: string | null;
      title: string;
      opened_by: 'user' | 'concierge';
      needs_human: 0 | 1;
      archived_at: number | null;
      created_at: number;
      updated_at: number;
      match_snippet: string | null;
    }
    // Pull every distinct session whose title OR any message content
    // matches. Use a LEFT JOIN + GROUP BY so we can pick a single
    // representative matching message excerpt per session in one
    // query (no per-row fan-out). The `MIN(...) FILTER` pattern
    // grabs the FIRST matching message body per session — sqlite
    // doesn't support FILTER on aggregates pre-3.30, so use CASE.
    const rows = ctx.db
      .prepare<[string, string, string, number], SessionRow>(
        `SELECT
            s.id, s.folder_id, s.title, s.opened_by, s.needs_human,
            s.archived_at, s.created_at, s.updated_at,
            (SELECT m.content FROM concierge_messages m
              WHERE m.session_id = s.id
                AND m.role IN ('user','assistant')
                AND lower(m.content) LIKE ?
              ORDER BY m.created_at ASC
              LIMIT 1) AS match_snippet
           FROM concierge_sessions s
          WHERE (
                lower(s.title) LIKE ?
             OR EXISTS (
                  SELECT 1 FROM concierge_messages m
                   WHERE m.session_id = s.id
                     AND m.role IN ('user','assistant')
                     AND lower(m.content) LIKE ?
                )
          )
          ${archiveClause}
          ORDER BY s.updated_at DESC
          LIMIT ?`,
      )
      .all(pattern, pattern, pattern, limit);
    const items = rows.map((r) => ({
      id: r.id,
      folderId: r.folder_id,
      title: r.title,
      openedBy: r.opened_by,
      needsHuman: r.needs_human === 1,
      archivedAt: r.archived_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      matchSnippet: r.match_snippet ? extractMatchSnippet(r.match_snippet, q) : null,
    }));
    return c.json({ items, query: q });
  });

  // `:id` comes AFTER `/search` because Hono matches routes in
  // declaration order — declaring `:id` first makes `/sessions/search`
  // match as `id="search"` and 404 with `not_found`.
  app.get('/api/concierge/sessions/:id', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const session = bag.bag.sessions.get(c.req.param('id'));
    if (!session) return c.json({ error: 'not_found' }, 404);
    return c.json(session);
  });

  app.patch('/api/concierge/sessions/:id', async (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const id = c.req.param('id');
    const patch = sessionPatchSchema.parse(await c.req.json());
    const current = bag.bag.sessions.get(id);
    if (!current) return c.json({ error: 'not_found' }, 404);
    if (patch.title !== undefined) bag.bag.sessions.rename(id, patch.title);
    if (patch.archived === true) bag.bag.sessions.archive(id);
    if (patch.archived === false) bag.bag.sessions.unarchive(id);
    if (patch.needsHuman !== undefined) bag.bag.sessions.setNeedsHuman(id, patch.needsHuman);
    return c.json(bag.bag.sessions.get(id));
  });

  app.delete('/api/concierge/sessions/:id', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    bag.bag.sessions.delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  // Transcript fetch. The chat dispatch (POST /messages) lives in
  // a separate session-messages module — that's the LLM-dispatch
  // path. This GET is plain reads for UI pagination.
  app.get('/api/concierge/sessions/:id/messages', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const sessionId = c.req.param('id');
    if (!bag.bag.sessions.get(sessionId)) return c.json({ error: 'not_found' }, 404);
    const limit = Math.min(Number(c.req.query('limit') ?? 500), 1000);
    return c.json({ items: bag.bag.messages.listBySession(sessionId, limit) });
  });
}
