import { describe, it, expect, beforeEach } from 'vitest';
import {
  activatePro,
  setup,
  type Ctx,
} from '../helpers/concierge-http-setup.js';

/**
 * Fresh-seed lifecycle: first GET seeds the registry-shipped
 * templates as editable rows; the v2-draft guard prevents migrating
 * the folder's `workflowTemplate` setting to the seeded ULID
 * (because L2 linear runner can't dispatch v2 drafts); subsequent
 * GETs are idempotent.
 */
describe('HTTP /api/auto-code/workflows — seeding · fresh-seed', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    activatePro(ctx.settings);
  });

  it('GET auto-seeds the registry-shipped templates on first list (Этап 6)', async () => {
    const folder = ctx.folders.create('F');
    const res = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflows: Array<{ id: string; name: string; isDefault: boolean }>;
    };
    // Seeded — every shipped template lands as an editable row.
    expect(body.workflows.length).toBeGreaterThan(0);
    // Exactly one row carries isDefault=true (corresponds to the
    // DEFAULT_TEMPLATE_ID registry entry).
    expect(body.workflows.filter((w) => w.isDefault)).toHaveLength(1);
    // Names match the registry labels (no synthetic "(seeded)"
    // suffix or similar). Post-trim default label changed (ticket
    // 01KRWRHFAK7HPQYV8GN72BW2VC).
    expect(body.workflows.some((w) => w.name === 'Code + code review · Mo-driven')).toBe(true);
  });

  it('Seeding does NOT migrate workflowTemplate when seeded default is a v2 draft (Codex P1 round 3, 2026-05-11)', async () => {
    // Under the Editor Model v2 spec (Morion note
    // 01KRAQWPXR5AYTFVF6J12TYHJ1) the seeded default row's definition
    // is a v2 draft (mo_stage / reject_sink / complete_sink). The L2
    // linear runner can't dispatch v2 drafts — auto-pointing the
    // folder's workflowTemplate setting at the v2 ULID would make
    // every drag-to-todo return workflow_not_runnable until the
    // Phase 4 DAG runner ships. Migration is gated on
    // !isDraftWorkflowDefinition; folders keep their stored value
    // (default fallback `default-v2` registry id which the resolver
    // also maps to LEGACY_LINEAR via miss path).
    const folder = ctx.folders.create('F');
    const list = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    const body = (await list.json()) as {
      workflows: Array<{ id: string; isDefault: boolean }>;
    };
    const defaultRow = body.workflows.find((w) => w.isDefault);
    expect(defaultRow).toBeDefined();
    const settingsRes = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
    );
    const settings = (await settingsRes.json()) as { workflowTemplate: string };
    // Setting stayed at its bare-default value — NOT migrated to the
    // seeded ULID. Once Phase 4 lands the gate flips and seeded ULID
    // becomes the active selection again.
    expect(settings.workflowTemplate).not.toBe(defaultRow!.id);
  });

  it('GET seeding is idempotent — second call does not duplicate rows', async () => {
    const folder = ctx.folders.create('F');
    const first = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    const firstBody = (await first.json()) as { workflows: unknown[] };
    const second = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    const secondBody = (await second.json()) as { workflows: unknown[] };
    expect(secondBody.workflows.length).toBe(firstBody.workflows.length);
  });
});
