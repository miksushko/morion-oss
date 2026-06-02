import { beforeEach, describe, expect, it } from 'vitest';

import type { Tag } from '../src/core/notes/types.js';
import { type Ctx, setup, json, patchJson } from './http/helpers.js';

describe('HTTP /api/tags', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it('creates a tag with name and color', async () => {
    const res = await ctx.app.request('/api/tags', json({ name: 'priority', color: '#ff5733' }));
    expect(res.status).toBe(201);
    const tag = (await res.json()) as Tag;
    expect(tag.name).toBe('priority');
    expect(tag.color).toBe('#ff5733');
    expect(tag.noteCount).toBe(0);
  });

  it('rejects an invalid hex color with a structured 400', async () => {
    const res = await ctx.app.request('/api/tags', json({ name: 'bad', color: 'not-a-color' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string }[] };
    expect(body.error).toBe('validation');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.some((i) => i.path === 'color')).toBe(true);
  });

  it('lists tags with note counts after assignment via notes_create', async () => {
    await ctx.app.request(
      '/api/notes',
      json({ body: 'A', tags: ['urgent', 'work'] }),
    );
    await ctx.app.request('/api/notes', json({ body: 'B', tags: ['urgent'] }));

    const res = await ctx.app.request('/api/tags');
    const tags = (await res.json()) as Tag[];
    const byName = Object.fromEntries(tags.map((t) => [t.name, t]));
    expect(byName.urgent.noteCount).toBe(2);
    expect(byName.work.noteCount).toBe(1);
  });

  it('renames and recolors a tag via PATCH', async () => {
    const created = ctx.tags.create('old', '#000000');
    const res = await ctx.app.request(
      `/api/tags/${created.id}`,
      patchJson({ name: 'new', color: '#ffffff' }),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Tag;
    expect(updated.name).toBe('new');
    expect(updated.color).toBe('#ffffff');
  });

  it('returns 404 when patching a missing tag', async () => {
    const res = await ctx.app.request('/api/tags/does-not-exist', patchJson({ name: 'x' }));
    expect(res.status).toBe(404);
  });

  it('returns 409 when creating a duplicate-name tag', async () => {
    await ctx.app.request('/api/tags', json({ name: 'dup' }));
    const res = await ctx.app.request('/api/tags', json({ name: 'dup' }));
    expect(res.status).toBe(409);
  });

  it('deletes a tag and cascades note_tags', async () => {
    const created = await ctx.app.request('/api/notes', json({ body: 'N', tags: ['x'] }));
    expect(created.status).toBe(201);
    const tag = ctx.tags.findByName('x');
    expect(tag).not.toBeNull();

    const del = await ctx.app.request(`/api/tags/${tag!.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    // Re-deleting is a 404.
    const del2 = await ctx.app.request(`/api/tags/${tag!.id}`, { method: 'DELETE' });
    expect(del2.status).toBe(404);
  });
});
