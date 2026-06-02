import { describe, it, expect, beforeEach } from 'vitest';
import {
  activatePro,
  setup,
  type Ctx,
} from '../helpers/concierge-http-setup.js';

/**
 * Path (3.5) hard-purge of schema-invalid rows + path (3) user-edit
 * preservation guard (`updated_at > created_at` sentinel). The two
 * sit at opposite ends of "should I touch this row?": invalid → drop
 * it; user-edited → leave it alone forever.
 */
describe('HTTP /api/auto-code/workflows — seeding · schema-invalid + user-edits', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    activatePro(ctx.settings);
  });

  it('Schema-invalid workflow rows are HARD-deleted on first list (2026-05-11)', async () => {
    // `listForFolder` skips rows whose JSON fails
    // WorkflowDefinitionSchema, but they sit in DB until the
    // user clicks them — getById 404s because it returns null
    // when parsing fails. User reported: sidebar entry that
    // explodes on open. Path (3.5) now scans raw DB rows + drops
    // any row that doesn't pass safeParse.
    const folder = ctx.folders.create('F');
    const corruptRowId = 'corrupt-row';
    // Definition with a human_gate that has TWO outbound edges —
    // the refined v2 spec (2026-05-11) restricts human_gate to a
    // single outbound edge. A row saved before this rule shipped
    // now fails WorkflowDefinitionSchema.parse.
    const corruptDef = JSON.stringify({
      schemaVersion: 1,
      name: 'corrupt',
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
        {
          id: 'human',
          kind: 'human_gate',
          prompt: 'go?',
        },
        { id: 'reject_terminal', kind: 'reject_sink', commentTemplate: '' },
        {
          id: 'complete_terminal',
          kind: 'complete_sink',
          commentTemplate: '',
        },
      ],
      edges: [
        { from: 'mo_start', to: 'human', on: 'accept' },
        { from: 'mo_start', to: 'reject_terminal', on: 'reject' },
        // Two outbound edges from human_gate — violates the v2
        // single-out rule. Schema parse fails.
        { from: 'human', to: 'complete_terminal', on: 'continue' },
        { from: 'human', to: 'reject_terminal', on: 'abort' },
      ],
    });
    const now = Date.now();
    ctx.handle.db
      .prepare(
        `INSERT INTO workflows (id, folder_id, name, definition_json,
                                is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(corruptRowId, folder.id, 'Corrupt v1', corruptDef, 0, now, now);
    // First list call triggers path (3.5) hard-purge.
    await ctx.app.request(`/api/auto-code/workflows?folderId=${folder.id}`);
    // Row gone from raw DB.
    const remaining = ctx.handle.db
      .prepare(`SELECT id FROM workflows WHERE id = ?`)
      .get(corruptRowId);
    expect(remaining).toBeUndefined();
    // GET by id 404s cleanly (row no longer in DB).
    const get = await ctx.app.request(
      `/api/auto-code/workflows/${corruptRowId}`,
    );
    expect(get.status).toBe(404);
  });

  it('Path (3) does NOT overwrite user-edited seeded rows (preserves updated_at > created_at)', async () => {
    // User opens popup → list call runs path (3) which UPDATEs
    // pristine seeded rows with the latest registry definition.
    // After the user adds a stage + saves, the row diverges from
    // the registry's stage-id set. Without the user-edit guard the
    // NEXT list call's path (3) would refresh the row again,
    // OVERWRITING the user's stage with the registry version.
    // Sentinel: `row.updated_at > row.created_at` means the row
    // has been touched (either by a prior path-3 refresh or by a
    // user save). Either way — leave it alone.
    const folder = ctx.folders.create('F');
    const editedRowId = 'user-edited-seeded';
    // Definition with an EXTRA mo_stage the user added — diverges
    // from the registry's stage-id set for 'default-v2'.
    const userDef = JSON.stringify({
      schemaVersion: 1,
      name: 'Default · Mo-driven (user version)',
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
        // User-added stage (not in registry definition).
        {
          id: 'user_added_stage',
          kind: 'mo_stage',
          instruction: 'extra Mo decision',
          branches: ['ok', 'no'],
          postComment: true,
          isStart: false,
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
    const createdAt = Date.now();
    const updatedAt = createdAt + 1000; // simulate user save
    ctx.handle.db
      .prepare(
        `INSERT INTO workflows (id, folder_id, name, definition_json,
                                is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        editedRowId,
        folder.id,
        'Default · Mo-driven (user version)',
        userDef,
        1,
        createdAt,
        updatedAt,
      );
    // Provenance pegs this row to 'default-v2' in the current
    // registry — without the guard, path (3) would see "stage-id
    // sets differ" and refresh.
    ctx.settings.set(`auto_code.seeded_templates.${folder.id}`, 'default-v2');
    ctx.settings.set(
      `auto_code.seeded_row_provenance.${folder.id}`,
      JSON.stringify({ [editedRowId]: 'default-v2' }),
    );
    await ctx.app.request(`/api/auto-code/workflows?folderId=${folder.id}`);
    // User's edits MUST survive — fetch by id and verify the
    // user-added stage is still in the definition.
    const fetched = await ctx.app.request(
      `/api/auto-code/workflows/${editedRowId}`,
    );
    expect(fetched.status).toBe(200);
    const body = (await fetched.json()) as {
      definition: { stages: Array<{ id: string }> };
    };
    const stageIds = body.definition.stages.map((s) => s.id);
    expect(stageIds).toContain('user_added_stage');
  });
});
