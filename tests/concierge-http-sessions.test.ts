import { describe, it, expect, beforeEach } from 'vitest';
import { activatePro, json, setup, type Ctx } from './helpers/concierge-http-setup.js';

/**
 * HTTP /api/concierge/sessions + /sessions/:id/messages
 *
 * Extracted 2026-05-16 from tests/concierge-http.test.ts as part of the
 * oversized-file split (Morion ticket 01KRJZ050EX392K9NY7GAKA1JE).
 */

describe('HTTP /api/concierge/sessions', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('GET lists sessions with a needsHumanCount', async () => {
    ctx.concierge.sessions.create({ openedBy: 'user' });
    ctx.concierge.sessions.create({ openedBy: 'concierge', needsHuman: true });
    const res = await ctx.app.request('/api/concierge/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; needsHumanCount: number };
    expect(body.items).toHaveLength(2);
    expect(body.needsHumanCount).toBe(1);
  });

  it('POST creates a user-opened session on Pro', async () => {
    activatePro(ctx.settings);
    const res = await ctx.app.request(
      '/api/concierge/sessions',
      json({ title: 'Deploy questions' }),
    );
    expect(res.status).toBe(200);
    const session = (await res.json()) as { id: string; title: string; openedBy: string };
    expect(session.title).toBe('Deploy questions');
    expect(session.openedBy).toBe('user');
  });

  // Regression for Morion ticket 01KRPT4BQT18H8HVKGA3026WDD — the
  // listing route only honoured `?includeArchived=1`, silently dropping
  // archived rows when the (more conventional) `=true` was passed.
  describe('includeArchived query param', () => {
    async function listSessions(qs: string): Promise<unknown[]> {
      const res = await ctx.app.request(`/api/concierge/sessions${qs}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      return body.items;
    }

    it('defaults to hiding archived sessions', async () => {
      activatePro(ctx.settings);
      const active = ctx.concierge.sessions.create({ openedBy: 'user' });
      const toArchive = ctx.concierge.sessions.create({ openedBy: 'user' });
      ctx.concierge.sessions.archive(toArchive.id);
      const items = (await listSessions('')) as Array<{ id: string }>;
      expect(items.map((i) => i.id)).toEqual([active.id]);
    });

    it('PATCH archived=true then includeArchived=1 surfaces the row', async () => {
      activatePro(ctx.settings);
      const s = ctx.concierge.sessions.create({ openedBy: 'user' });
      const patchRes = await ctx.app.request(
        `/api/concierge/sessions/${s.id}`,
        { ...json({ archived: true }), method: 'PATCH' },
      );
      expect(patchRes.status).toBe(200);
      const patched = (await patchRes.json()) as { archivedAt: number | null };
      expect(patched.archivedAt).not.toBeNull();
      const items = (await listSessions('?includeArchived=1')) as Array<{ id: string }>;
      expect(items.map((i) => i.id)).toContain(s.id);
    });

    it('accepts includeArchived=true (the conventional boolean form)', async () => {
      activatePro(ctx.settings);
      const s = ctx.concierge.sessions.create({ openedBy: 'user' });
      ctx.concierge.sessions.archive(s.id);
      const items = (await listSessions('?includeArchived=true')) as Array<{ id: string }>;
      expect(items.map((i) => i.id)).toContain(s.id);
    });

    it('ignores includeArchived=0 / =false / typos', async () => {
      activatePro(ctx.settings);
      const s = ctx.concierge.sessions.create({ openedBy: 'user' });
      ctx.concierge.sessions.archive(s.id);
      for (const qs of ['?includeArchived=0', '?includeArchived=false', '?includeArchived=yes', '']) {
        const items = (await listSessions(qs)) as Array<{ id: string }>;
        expect(items.map((i) => i.id), `qs=${qs}`).not.toContain(s.id);
      }
    });
  });
});

describe('HTTP /api/concierge/sessions/:id/messages', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('GET returns the transcript', async () => {
    const s = ctx.concierge.sessions.create({ openedBy: 'user' });
    ctx.concierge.messages.create({ sessionId: s.id, role: 'user', content: 'hi' });
    ctx.concierge.messages.create({ sessionId: s.id, role: 'assistant', content: 'hello' });
    const res = await ctx.app.request(`/api/concierge/sessions/${s.id}/messages`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ role: string; content: string }> };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]!.role).toBe('user');
  });

  it('POST persists user + assistant turn via Noop provider, clears needs_human', async () => {
    activatePro(ctx.settings);
    const s = ctx.concierge.sessions.create({ openedBy: 'concierge', needsHuman: true });
    const res = await ctx.app.request(
      `/api/concierge/sessions/${s.id}/messages`,
      json({ content: 'respond please' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { role: string };
      assistant: { role: string; content: string };
    };
    expect(body.user.role).toBe('user');
    expect(body.assistant.role).toBe('assistant');
    // Noop provider surfaces the "not configured" message.
    expect(body.assistant.content.toLowerCase()).toMatch(/not configured|concierge error/);
    const after = ctx.concierge.sessions.get(s.id);
    expect(after!.needsHuman).toBe(false);
  });
});
