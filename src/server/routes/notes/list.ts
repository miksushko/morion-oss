import type { Hono } from 'hono';
import { z } from 'zod';
import type { ToolContext } from '../../tools/types.js';
import { filterReadable } from '../../../core/permissions/check.js';

/**
 * `GET /api/notes` — paginated list. Must register BEFORE
 * `/api/notes/:id`-shaped routes per Hono trie ordering (the bare
 * /api/notes path is one segment less, but registering it first keeps
 * intent clear and matches the original file's layout).
 *
 * On Pro tier we recompute `X-Total-Count` through `filterReadable`
 * so hidden-folder counts don't leak (audit N2). Direction Q enriches
 * each row with `commentCount` via a single batched
 * `countForNotes` query (R6 N+1 lesson).
 *
 * Extracted from src/server/routes/notes.ts during the 2026-05-16
 * split (Morion ticket 01KRR8J8ED8E8QE37W3QRBP8G7).
 */
export function registerNotesListRoute(app: Hono, ctx: ToolContext): void {
  const listQuerySchema = z.object({
    folderId: z.string().optional(),
    tag: z.string().optional(),
    pinned: z.enum(['true', 'false']).optional(),
    includeArchived: z.enum(['0', '1', 'true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(1000),
    offset: z.coerce.number().int().min(0).default(0),
  });

  app.get('/api/notes', (c) => {
    const parsed = listQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const includeArchived =
      parsed.includeArchived === '1' || parsed.includeArchived === 'true';
    const filters = {
      folderId: parsed.folderId,
      tag: parsed.tag,
      pinned: parsed.pinned ? parsed.pinned === 'true' : undefined,
      includeArchived,
    };
    const page = ctx.notes.list({ ...filters, limit: parsed.limit, offset: parsed.offset });
    const visible = filterReadable(page, ctx);
    // count() can't be trusted for an MCP caller — it would leak how many
    // notes exist in a folder the caller can't read (finding N2,
    // 2026-04-16). Compute the total by scanning the full (capped) set
    // through the same permission filter. filterReadable is a no-op for
    // user-actor, so the scan is only a real cost on the MCP path.
    const all = ctx.notes.list({ ...filters, limit: 5000, offset: 0 });
    const total = filterReadable(all, ctx).length;
    c.header('X-Total-Count', String(total));
    // Direction Q — enrich with per-card comment counts so the kanban
    // board badge renders without an extra round-trip. One batched
    // `countForNotes` query (R6 N+1 lesson) keeps the cost constant
    // regardless of page size.
    const counts = ctx.comments.countForNotes(visible.map((n) => n.id));
    const enriched = visible.map((n) => ({
      ...n,
      commentCount: counts.get(n.id) ?? 0,
    }));
    return c.json(enriched);
  });
}
