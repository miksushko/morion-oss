import type { Hono } from 'hono';
import { z } from 'zod';
import type { ToolContext } from '../tools/types.js';
import { duplicateFolder } from '../../core/folders/duplicate.js';
import { deleteFolderWithNotes } from '../features/folder-delete.js';

/**
 * Folder CRUD + reorder + duplicate.
 *
 * `/reorder` and `/:id/duplicate` must be declared before the `/:id`
 * PATCH/DELETE so hono matches literal segments first instead of
 * capturing them as id parameters. Kanban view-mode toggle and
 * permission writes live in their own route files (`kanban.ts`,
 * `license.ts`) for bounded-context separation.
 */
export function registerFolderRoutes(app: Hono, ctx: ToolContext): void {
  const actor = ctx.actor;

  app.get('/api/folders', (c) => {
    const includeArchived =
      ['1', 'true'].includes(
        new URL(c.req.url).searchParams.get('includeArchived') ?? '',
      );
    return c.json(ctx.folders.list({ includeArchived }));
  });

  const folderCreateSchema = z.object({
    name: z.string().min(1).max(200),
    parentId: z.string().nullable().optional(),
  });

  app.post('/api/folders', async (c) => {
    const body = await c.req.json();
    const input = folderCreateSchema.parse(body);
    const folder = ctx.folders.create(input.name, input.parentId ?? null);
    return c.json(folder, 201);
  });

  // Reorder route must be declared before `/:id` so hono doesn't
  // match "reorder" as a folder id parameter.
  const folderReorderSchema = z.object({ orderedIds: z.array(z.string().min(1)) });

  app.patch('/api/folders/reorder', async (c) => {
    const body = await c.req.json();
    const input = folderReorderSchema.parse(body);
    ctx.folders.reorder(input.orderedIds);
    return c.json(ctx.folders.list());
  });

  // Duplicate a folder + every non-deleted note inside it. Same
  // caveat as /reorder above: declared before `/:id` so the literal
  // segment matches first instead of being captured as an id
  // parameter.
  app.post('/api/folders/:id/duplicate', async (c) => {
    const result = duplicateFolder(ctx.folders, ctx.notes, c.req.param('id'), actor);
    if (!result) return c.json({ error: 'not found' }, 404);
    // Embed the freshly-copied notes so they're searchable immediately.
    for (const id of result.newNoteIds) {
      const note = ctx.notes.getById(id);
      if (note) await ctx.indexer.reindex(note);
    }
    return c.json(result.folder, 201);
  });

  // Single-step move within the parent's ordering. The body says
  // which direction; the repo handles the index math + boundary
  // check.
  const folderMoveSchema = z.object({ direction: z.enum(['up', 'down']) });

  app.post('/api/folders/:id/move', async (c) => {
    const body = await c.req.json();
    const input = folderMoveSchema.parse(body);
    const ok = ctx.folders.move(c.req.param('id'), input.direction === 'up' ? -1 : 1);
    if (!ok) return c.json({ error: 'not found or at boundary' }, 404);
    return c.json(ctx.folders.list());
  });

  const folderRenameSchema = z.object({ name: z.string().min(1).max(200) });

  app.patch('/api/folders/:id', async (c) => {
    const body = await c.req.json();
    const input = folderRenameSchema.parse(body);
    const ok = ctx.folders.rename(c.req.param('id'), input.name);
    if (!ok) return c.json({ error: 'not found' }, 404);
    const folder = ctx.folders.getById(c.req.param('id'));
    return c.json(folder);
  });

  app.delete('/api/folders/:id', (c) => {
    const id = c.req.param('id');
    // Default: move the folder's notes to Trash with it. Pass
    // `?keepNotes=1` to preserve them as unfiled (folder_id → NULL)
    // instead. mo:* system notes are always hard-deleted either way.
    // See src/server/features/folder-delete.ts.
    const keepNotes = ['1', 'true'].includes(
      new URL(c.req.url).searchParams.get('keepNotes') ?? '',
    );
    const { ok, trashedNoteCount } = deleteFolderWithNotes(ctx, id, {
      keepNotes,
    });
    if (!ok) return c.json({ error: 'not found' }, 404);
    // `deletedNoteCount` kept as an alias for back-compat with any
    // client reading the old field name.
    return c.json({ ok, trashedNoteCount, deletedNoteCount: trashedNoteCount });
  });

  // ---------- archive ----------
  // Archiving a folder hides it + its notes from default lists + MCP.
  // Notes inside keep their individual `archived_at` untouched so an
  // unarchive restores the exact prior state.
  app.post('/api/folders/:id/archive', (c) => {
    const folder = ctx.folders.setArchived(c.req.param('id'), true);
    if (!folder) return c.json({ error: 'not found or already archived' }, 404);
    return c.json(folder);
  });

  app.post('/api/folders/:id/unarchive', (c) => {
    const folder = ctx.folders.setArchived(c.req.param('id'), false);
    if (!folder) return c.json({ error: 'not found or not archived' }, 404);
    return c.json(folder);
  });
}
