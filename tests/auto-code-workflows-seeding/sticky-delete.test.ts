import { describe, it, expect, beforeEach } from 'vitest';
import {
  activatePro,
  json,
  setup,
  SIMPLE_DEFINITION,
  type Ctx,
} from '../helpers/concierge-http-setup.js';

/**
 * Sticky-delete + explicit user pick semantics: deleting a SEEDED
 * template stays sticky across re-list, but deleting a USER-CREATED
 * row that happens to share a registry label MUST NOT suppress the
 * shipped template (sticky-delete is provenance-keyed, not name-
 * keyed). And an explicit user pick (a non-registry ULID) survives
 * the seeding pipeline untouched.
 */
describe('HTTP /api/auto-code/workflows — seeding · sticky-delete + user-pick', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    activatePro(ctx.settings);
  });

  it('Seeding does NOT clobber an explicit user pick (a non-registry ULID)', async () => {
    const folder = ctx.folders.create('F');
    // First open seeds + sets setting to seeded default ULID.
    await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    // User creates a brand-new workflow + picks it.
    const created = await ctx.app.request(
      '/api/auto-code/workflows',
      json({
        folderId: folder.id,
        name: 'My pick',
        definition: SIMPLE_DEFINITION,
      }),
    );
    const cb = (await created.json()) as { id: string };
    await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ workflowTemplate: cb.id }, 'PUT'),
    );
    // Re-list — seeding logic must NOT overwrite the user's
    // explicit pick (it's a ULID, not a registry id).
    await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    const settingsRes = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
    );
    const settings = (await settingsRes.json()) as { workflowTemplate: string };
    expect(settings.workflowTemplate).toBe(cb.id);
  });

  it('Sticky-delete keys on provenance, not on row name (Codex P2a round 6)', async () => {
    const folder = ctx.folders.create('F');
    // First open seeds the registry templates.
    await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    // User creates a CUSTOM workflow whose name happens to
    // collide with a shipped template's label. Post-trim (ticket
    // 01KRWRHFAK7HPQYV8GN72BW2VC) the default label is "Code +
    // code review · Mo-driven".
    const created = await ctx.app.request(
      '/api/auto-code/workflows',
      json({
        folderId: folder.id,
        name: 'Code + code review · Mo-driven',
        definition: SIMPLE_DEFINITION,
      }),
    );
    const cb = (await created.json()) as { id: string };
    // User deletes that custom workflow. With name-based sticky
    // delete this would suppress the shipped template; with
    // provenance-keyed sticky-delete it must NOT (the deleted
    // row has no entry in the provenance map).
    await ctx.app.request(
      `/api/auto-code/workflows/${cb.id}`,
      { method: 'DELETE' },
    );
    // Re-list — the seeded shipped row stays alive (it has a
    // different ULID + IS in the provenance map).
    const list = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    const body = (await list.json()) as {
      workflows: Array<{ id: string; name: string }>;
    };
    const shipped = body.workflows.filter(
      (w) => w.name === 'Code + code review · Mo-driven',
    );
    // Exactly one row by that label — the seeded shipped one;
    // the user's custom row has been deleted and is NOT
    // re-suppressing the shipped row.
    expect(shipped).toHaveLength(1);
  });

  it('Deleting a seeded template stays sticky — next list does NOT re-add it', async () => {
    const folder = ctx.folders.create('F');
    // First open seeds the 3 base templates (post-trim).
    const first = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    const firstBody = (await first.json()) as {
      workflows: Array<{ id: string; name: string }>;
    };
    const seeded = firstBody.workflows.find(
      (w) => w.name === 'Code only · Mo-driven',
    );
    expect(seeded).toBeDefined();
    // User deletes one of the seeded templates.
    const del = await ctx.app.request(
      `/api/auto-code/workflows/${seeded!.id}`,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(200);
    // Re-list — the deleted template MUST stay gone.
    const second = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    const secondBody = (await second.json()) as {
      workflows: Array<{ name: string }>;
    };
    expect(
      secondBody.workflows.find((w) => w.name === 'Code only · Mo-driven'),
    ).toBeUndefined();
  });
});
