import type { Hono } from 'hono';
import { z } from 'zod';
import type { ToolContext } from '../tools/types.js';

/**
 * Per-resource MCP permission mutations — the "visible / create / update /
 * delete to AI" toggles on folders and notes.
 *
 * These gate the `mcp:*` actor only; the user UI always sees its own data
 * (see core/permissions/check.ts for the read/enforce side). A free feature
 * in the open-source build — there is no license tier.
 */
export function registerPermissionsRoutes(app: Hono, ctx: ToolContext): void {
  // Folder permissions — all four booleans required so the caller
  // has explicitly considered each gate; no partial-update footgun.
  const folderPermsSchema = z.object({
    visible: z.boolean(),
    create: z.boolean(),
    update: z.boolean(),
    delete: z.boolean(),
  });

  app.put('/api/folders/:id/permissions', async (c) => {
    const perms = folderPermsSchema.parse(await c.req.json());
    const updated = ctx.folders.setMcpPermissions(c.req.param('id'), perms);
    if (!updated) return c.json({ error: 'not found' }, 404);
    return c.json(updated);
  });

  // Per-note overrides — every field nullable. null means "inherit
  // from the containing folder".
  const notePermsSchema = z.object({
    visible: z.boolean().nullable(),
    update: z.boolean().nullable(),
    delete: z.boolean().nullable(),
  });

  app.put('/api/notes/:id/permissions', async (c) => {
    const perms = notePermsSchema.parse(await c.req.json());
    const updated = ctx.notes.setMcpPermissions(c.req.param('id'), perms);
    if (!updated) return c.json({ error: 'not found' }, 404);
    return c.json(updated);
  });
}
