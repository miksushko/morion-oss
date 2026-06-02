import type { Hono } from 'hono';
import type { ToolContext } from '../../tools/types.js';

/**
 * Archive / unarchive — distinct from trash. Archived notes stay in
 * the DB forever (no 7-day purge), are hidden from default UI lists +
 * all MCP reads, and can be toggled back with unarchive. User origin
 * only — MCP has no archive/unarchive tool by design (agents should
 * not touch a user's "keep but hide" pile).
 *
 * Extracted from src/server/routes/notes.ts during the 2026-05-16
 * split (Morion ticket 01KRR8J8ED8E8QE37W3QRBP8G7).
 */
export function registerNotesArchiveRoutes(app: Hono, ctx: ToolContext): void {
  const actor = ctx.actor;

  app.post('/api/notes/:id/archive', (c) => {
    const id = c.req.param('id');
    const existing = ctx.notes.getById(id);
    if (!existing) return c.json({ error: 'not found' }, 404);
    if (!ctx.notes.archive(id, actor)) {
      return c.json({ error: 'already archived or trashed' }, 409);
    }
    return c.json(ctx.notes.getById(id));
  });

  app.post('/api/notes/:id/unarchive', (c) => {
    const id = c.req.param('id');
    const existing = ctx.notes.getById(id);
    if (!existing) return c.json({ error: 'not found' }, 404);
    if (!ctx.notes.unarchive(id, actor)) {
      return c.json({ error: 'not archived' }, 409);
    }
    return c.json(ctx.notes.getById(id));
  });
}
