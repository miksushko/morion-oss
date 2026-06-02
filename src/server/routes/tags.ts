import type { Hono } from 'hono';
import { z } from 'zod';
import type { ToolContext } from '../tools/types.js';

/**
 * Tag CRUD. Flat namespace — no per-tag permissions, no hierarchy,
 * no parent/child. A tag is a coloured label; the notebook never has
 * so many of them that advanced organisation pays off.
 */
export function registerTagRoutes(app: Hono, ctx: ToolContext): void {
  app.get('/api/tags', (c) => c.json(ctx.tags.list()));

  // Hex color: `#` + 3, 4, 6, or 8 hex digits. Null clears the color.
  const colorSchema = z
    .string()
    .regex(/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'invalid hex color')
    .nullable();

  const tagCreateSchema = z.object({
    name: z.string().min(1).max(64),
    color: colorSchema.optional(),
  });

  app.post('/api/tags', async (c) => {
    const body = await c.req.json();
    const input = tagCreateSchema.parse(body);
    try {
      const tag = ctx.tags.create(input.name, input.color ?? null);
      return c.json(tag, 201);
    } catch (err) {
      // Unique-name violation surfaces as a SQLite error.
      const message = err instanceof Error ? err.message : 'failed to create tag';
      return c.json({ error: message }, 409);
    }
  });

  const tagUpdateSchema = z
    .object({
      name: z.string().min(1).max(64).optional(),
      color: colorSchema.optional(),
    })
    .refine((v) => v.name !== undefined || v.color !== undefined, {
      message: 'name or color is required',
    });

  app.patch('/api/tags/:id', async (c) => {
    const body = await c.req.json();
    const input = tagUpdateSchema.parse(body);
    try {
      const tag = ctx.tags.update(c.req.param('id'), input);
      if (!tag) return c.json({ error: 'not found' }, 404);
      return c.json(tag);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to update tag';
      return c.json({ error: message }, 409);
    }
  });

  app.delete('/api/tags/:id', (c) => {
    const ok = ctx.tags.delete(c.req.param('id'));
    if (!ok) return c.json({ error: 'not found' }, 404);
    return c.json({ ok });
  });
}
