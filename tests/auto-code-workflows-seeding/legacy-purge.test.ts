import { describe, it, expect, beforeEach } from 'vitest';
import {
  activatePro,
  json,
  setup,
  type Ctx,
} from '../helpers/concierge-http-setup.js';

/**
 * Legacy-purge paths (1 / 2 / 3) of `purgeLegacyAndHeal` exercised
 * end-to-end through the GET handler: provenance-based purge,
 * pre-provenance name+shape purge, shape-gate preserves user
 * v2-authored rows, outdated v2-seed in-place refresh.
 */
describe('HTTP /api/auto-code/workflows — seeding · legacy-purge', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    activatePro(ctx.settings);
  });

  it('Legacy seeded rows (pre-v2 template ids) are purged on first list under v2 registry (2026-05-11)', async () => {
    // Simulate a folder seeded under the pre-v2 registry: insert a
    // workflow row directly into the DB + populate provenance / tracker
    // pointing at legacy ids ('default', 'bug-fix'). Set the folder's
    // active workflowTemplate to one of the legacy ULIDs.
    const folder = ctx.folders.create('F');
    const legacyRow1Id = 'legacy-row-1';
    const legacyRow2Id = 'legacy-row-2';
    const legacyDef = JSON.stringify({
      schemaVersion: 1,
      name: 'Default (legacy)',
      description: '',
      stages: [
        {
          id: 'fix',
          kind: 'cli_agent',
          agent: 'claude',
          promptTemplate: 'old',
          maxBudgetUsd: 1,
          maxAttempts: 1,
          allowedTools: [],
        },
      ],
      edges: [],
    });
    const now = Date.now();
    ctx.handle.db
      .prepare(
        `INSERT INTO workflows (id, folder_id, name, definition_json,
                                is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(legacyRow1Id, folder.id, 'Default (Claude → Codex review)', legacyDef, 1, now, now);
    ctx.handle.db
      .prepare(
        `INSERT INTO workflows (id, folder_id, name, definition_json,
                                is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(legacyRow2Id, folder.id, 'Bug fix', legacyDef, 0, now, now);
    // Provenance + tracker carry legacy ids that are NOT in the
    // current v2 registry.
    ctx.settings.set(
      `auto_code.seeded_templates.${folder.id}`,
      'default,bug-fix',
    );
    ctx.settings.set(
      `auto_code.seeded_row_provenance.${folder.id}`,
      JSON.stringify({
        [legacyRow1Id]: 'default',
        [legacyRow2Id]: 'bug-fix',
      }),
    );
    // User had the legacy default ULID as their active pick.
    await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ workflowTemplate: legacyRow1Id }, 'PUT'),
    );
    // Trigger purge + re-seed by listing.
    const list = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      workflows: Array<{ id: string; name: string }>;
    };
    const names = body.workflows.map((w) => w.name);
    // Legacy rows are gone.
    expect(body.workflows.find((w) => w.id === legacyRow1Id)).toBeUndefined();
    expect(body.workflows.find((w) => w.id === legacyRow2Id)).toBeUndefined();
    // v2 templates landed fresh — after the 3-template trim (ticket
    // 01KRWRHFAK7HPQYV8GN72BW2VC) the registry ships exactly three
    // base shapes; seeding plants each as an editable row using the
    // template's `label` (not `definition.name`).
    expect(names).toContain('Plan + plan review + code + code review · Mo-driven');
    expect(names).toContain('Code + code review · Mo-driven');
    expect(names).toContain('Code only · Mo-driven');
    // Active workflowTemplate setting was reset off the deleted ULID;
    // it now resolves through the miss path (LEGACY_LINEAR fallback).
    const settingsRes = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
    );
    const settings = (await settingsRes.json()) as { workflowTemplate: string };
    expect(settings.workflowTemplate).not.toBe(legacyRow1Id);
    // Idempotence: a second list does NOT delete anything.
    const list2 = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    const body2 = (await list2.json()) as { workflows: unknown[] };
    expect(body2.workflows.length).toBe(body.workflows.length);
  });

  it('Pre-provenance legacy seeded rows are purged by name + shape match (no provenance entries)', async () => {
    // Folders seeded BEFORE provenance tracking shipped (Codex P2a
    // round 6, 2026-05-10) have legacy workflow rows in DB but no
    // entries in `auto_code.seeded_row_provenance.<folderId>`. The
    // provenance-based purge path (1) misses them; the name + shape
    // based path (2) catches them.
    const folder = ctx.folders.create('F');
    const preProvenanceRowId = 'pre-provenance-legacy-row';
    const legacyDef = JSON.stringify({
      schemaVersion: 1,
      name: 'Default (Claude → Codex review)',
      description: '',
      stages: [
        {
          id: 'fix',
          kind: 'cli_agent',
          agent: 'claude',
          promptTemplate: 'old',
          maxBudgetUsd: 1,
          maxAttempts: 1,
          allowedTools: [],
        },
      ],
      edges: [],
    });
    const now = Date.now();
    ctx.handle.db
      .prepare(
        `INSERT INTO workflows (id, folder_id, name, definition_json,
                                is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        preProvenanceRowId,
        folder.id,
        'Default (Claude → Codex review)',
        legacyDef,
        1,
        now,
        now,
      );
    // No provenance settings written — simulating pre-2026-05-10 seed.
    const list = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      workflows: Array<{ id: string; name: string }>;
    };
    // Legacy row was matched by name + linear shape → deleted.
    expect(body.workflows.find((w) => w.id === preProvenanceRowId)).toBeUndefined();
    // v2 templates seeded fresh (post-trim 3 base shapes).
    expect(
      body.workflows.some((w) => w.name === 'Code + code review · Mo-driven'),
    ).toBe(true);
  });

  it('Path (2) shape-gate preserves user-authored workflows that share a legacy label', async () => {
    // A user-created workflow with name "Bug fix" (collides with
    // legacy registry label) BUT containing a mo_stage MUST NOT be
    // deleted by the name-based purge path. The shape gate
    // (hasV2Kind) protects it.
    const folder = ctx.folders.create('F');
    const userRowId = 'user-bug-fix-v2';
    const v2Def = JSON.stringify({
      schemaVersion: 1,
      name: 'Bug fix',
      description: '',
      stages: [
        {
          id: 'mo_start',
          kind: 'mo_stage',
          instruction: '',
          branches: ['accept', 'reject'],
          postComment: true,
          isStart: true,
          allowedTools: null,
        },
        { id: 'reject_terminal', kind: 'reject_sink', commentTemplate: '' },
        {
          id: 'complete_terminal',
          kind: 'complete_sink',
          commentTemplate: '',
        },
      ],
      edges: [
        { from: 'mo_start', to: 'complete_terminal', on: 'accept' },
        { from: 'mo_start', to: 'reject_terminal', on: 'reject' },
      ],
    });
    const now = Date.now();
    ctx.handle.db
      .prepare(
        `INSERT INTO workflows (id, folder_id, name, definition_json,
                                is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(userRowId, folder.id, 'Bug fix', v2Def, 0, now, now);
    const list = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    const body = (await list.json()) as {
      workflows: Array<{ id: string; name: string }>;
    };
    // User's workflow survives — shape gate caught the v2 kind.
    expect(body.workflows.find((w) => w.id === userRowId)).toBeDefined();
  });

  it('Outdated v2-seeded rows are REFRESHED in place, NOT re-issued with a new ULID (Codex round 5, 2026-05-11)', async () => {
    // Folders seeded under an earlier v2 registry definition keep
    // their workflows.id stable across registry updates — the
    // outdated-shape path (3) updates definition_json in place
    // instead of delete + re-insert. Without this the UI's cached
    // list ids 404 between the GET call (which deleted) and the
    // user's subsequent click (which fetched by the now-deleted id).
    const folder = ctx.folders.create('F');
    const stableRowId = 'outdated-but-stable-row';
    // Stale shape: the v2 template registered today has 4+ Mo
    // stages, but this row was seeded back when the template only
    // had mo_start + cli_agent + sinks (3 stages, no HITL).
    const staleDef = JSON.stringify({
      schemaVersion: 1,
      name: 'Default · Mo-driven (stale shape)',
      description: '',
      stages: [
        {
          id: 'mo_start',
          kind: 'mo_stage',
          instruction: 'old instruction',
          branches: ['accept', 'reject'],
          postComment: true,
          isStart: true,
          allowedTools: null,
        },
        { id: 'reject_terminal', kind: 'reject_sink', commentTemplate: '' },
        {
          id: 'complete_terminal',
          kind: 'complete_sink',
          commentTemplate: '',
        },
      ],
      edges: [
        { from: 'mo_start', to: 'complete_terminal', on: 'accept' },
        { from: 'mo_start', to: 'reject_terminal', on: 'reject' },
      ],
    });
    const now = Date.now();
    ctx.handle.db
      .prepare(
        `INSERT INTO workflows (id, folder_id, name, definition_json,
                                is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stableRowId,
        folder.id,
        'Default · Mo-driven (stale shape)',
        staleDef,
        1,
        now,
        now,
      );
    // Provenance maps this row to the 'default-v2' template id (which
    // IS in the current registry). Path (3) triggers because the
    // stage-id set differs from the current registry definition's.
    ctx.settings.set(`auto_code.seeded_templates.${folder.id}`, 'default-v2');
    ctx.settings.set(
      `auto_code.seeded_row_provenance.${folder.id}`,
      JSON.stringify({ [stableRowId]: 'default-v2' }),
    );
    const list = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      workflows: Array<{ id: string; name: string }>;
    };
    // Same ULID still appears — row wasn't deleted.
    expect(body.workflows.find((w) => w.id === stableRowId)).toBeDefined();
    // GET by that id still works (no 404).
    const fetched = await ctx.app.request(
      `/api/auto-code/workflows/${stableRowId}`,
    );
    expect(fetched.status).toBe(200);
  });
});
