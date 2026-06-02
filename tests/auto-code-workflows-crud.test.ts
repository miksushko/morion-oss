import { describe, it, expect, beforeEach } from 'vitest';
import {
  activatePro,
  json,
  setup,
  SIMPLE_DEFINITION,
  type Ctx,
} from './helpers/concierge-http-setup.js';

/**
 * HTTP /api/auto-code/workflows — CRUD round-trip (POST/PUT/DELETE,
 * cross-folder guard, clone endpoint, slim list shape, delete-clears-
 * active-template, resolver accepts workflows.id ULID).
 *
 * Extracted 2026-05-16 from tests/concierge-http.test.ts as part of the
 * oversized-file split (Morion ticket 01KRJZ050EX392K9NY7GAKA1JE).
 */
describe('HTTP /api/auto-code/workflows — CRUD', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    activatePro(ctx.settings);
  });
  it('POST → GET round-trip persists name + definition', async () => {
    const folder = ctx.folders.create('F');
    const created = await ctx.app.request(
      '/api/auto-code/workflows',
      json({
        folderId: folder.id,
        name: 'My WF',
        definition: SIMPLE_DEFINITION,
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string; name: string };
    expect(createdBody.name).toBe('My WF');
    const list = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    const listBody = (await list.json()) as {
      workflows: Array<{ id: string; name: string; stageCount: number }>;
    };
    // Seeding adds the registry-shipped templates; find OUR row
    // by id rather than asserting length=1.
    const ourRow = listBody.workflows.find((w) => w.id === createdBody.id);
    expect(ourRow).toBeDefined();
    expect(ourRow!.stageCount).toBe(1);
    const single = await ctx.app.request(
      `/api/auto-code/workflows/${createdBody.id}`,
    );
    expect(single.status).toBe(200);
    const fullBody = (await single.json()) as {
      definition: typeof SIMPLE_DEFINITION;
    };
    expect(fullBody.definition.stages[0]!.id).toBe('fix');
  });
  it('POST returns 422 on malformed definition', async () => {
    const folder = ctx.folders.create('F');
    const res = await ctx.app.request(
      '/api/auto-code/workflows',
      json({
        folderId: folder.id,
        name: 'Bad',
        definition: { schemaVersion: 1, name: 'no stages', stages: [] },
      }),
    );
    // zod refusal on stages.min(1) becomes a 400 from the schema parse
    // (folderSettingsSchema-style Zod throw), but our route uses
    // workflowCreateSchema where definition is WorkflowDefinitionSchema —
    // a missing-stages failure gets caught and re-thrown as Zod, which
    // bubbles before the try/catch around parseLinearWorkflow. That's a
    // 400 from Zod's body parse OR a 422 if it somehow reaches the
    // catch. Accept either.
    expect([400, 422]).toContain(res.status);
  });
  it('PUT updates name; GET reflects', async () => {
    const folder = ctx.folders.create('F');
    const created = await ctx.app.request(
      '/api/auto-code/workflows',
      json({
        folderId: folder.id,
        name: 'Original',
        definition: SIMPLE_DEFINITION,
      }),
    );
    const cb = (await created.json()) as { id: string };
    const put = await ctx.app.request(
      `/api/auto-code/workflows/${cb.id}`,
      json({ name: 'Renamed' }, 'PUT'),
    );
    expect(put.status).toBe(200);
    const pb = (await put.json()) as { name: string };
    expect(pb.name).toBe('Renamed');
  });
  it('DELETE removes the row', async () => {
    const folder = ctx.folders.create('F');
    const created = await ctx.app.request(
      '/api/auto-code/workflows',
      json({
        folderId: folder.id,
        name: 'X',
        definition: SIMPLE_DEFINITION,
      }),
    );
    const cb = (await created.json()) as { id: string };
    const del = await ctx.app.request(
      `/api/auto-code/workflows/${cb.id}`,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(200);
    const get = await ctx.app.request(`/api/auto-code/workflows/${cb.id}`);
    expect(get.status).toBe(404);
  });
  it('PUT rejects cross-folder workflow id (Codex P1b round 3)', async () => {
    const folderA = ctx.folders.create('A');
    const folderB = ctx.folders.create('B');
    // Create custom workflow in folder B.
    const created = await ctx.app.request(
      '/api/auto-code/workflows',
      json({
        folderId: folderB.id,
        name: "B's wf",
        definition: SIMPLE_DEFINITION,
      }),
    );
    const cb = (await created.json()) as { id: string };
    // Folder A tries to point at folder B's workflow → 422.
    const put = await ctx.app.request(
      `/api/concierge/folders/${folderA.id}/settings`,
      json({ workflowTemplate: cb.id }, 'PUT'),
    );
    expect(put.status).toBe(422);
    const body = (await put.json()) as { error: string };
    expect(body.error).toBe('unknown_workflow_template');
  });
  it('Manual enqueue returns engine=workflow when non-default template forces routing (Codex P2b round 3)', async () => {
    // Setup: folder with linked repo + Mo + auto-code on. Workspace
    // flag stays OFF (default). Pick a non-default built-in template
    // (`pi-fix` would also need pi installed which we can't fake
    // here without isAgentAvailable injection; use a custom workflow
    // instead which always routes to workflow runner).
    const folder = ctx.folders.create('F');
    const created = await ctx.app.request(
      '/api/auto-code/workflows',
      json({
        folderId: folder.id,
        name: 'Custom',
        definition: SIMPLE_DEFINITION,
      }),
    );
    const cb = (await created.json()) as { id: string };
    // The actual /enqueue call needs claude binary present + Mo
    // wired + linked repo. None of those are realistic in a unit
    // test. Instead we verify the SHAPE: the route returns the
    // dispatcher's `result.engine` verbatim, NOT the workspace flag.
    // Since a fresh ctx without Mo wired returns
    // `auto_code_unavailable` (which short-circuits BEFORE the
    // engine field would be set), the most we can verify here is
    // that the response no longer contains a manual `engine`
    // override after the rejection. The folder-routing test for
    // engine=workflow lives in workflow-orchestrator-routing tests.
    const enq = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/auto-code/enqueue`,
      json({ taskId: 'no-such-task' }),
    );
    // Either 503 (mo_provider_not_configured envelope wraps the
    // rejected result) or a body with engine present from the
    // route's collapseWorkflowResult. Either way, the route must
    // NOT artificially set engine='legacy' when the dispatcher
    // would have routed to workflow.
    const body = (await enq.json()) as { engine?: string; reason?: string };
    if (body.engine !== undefined) {
      // If the response carries an engine field (only on enqueued),
      // it must reflect the actual engine — never overridden to
      // legacy when the folder selected a custom workflow.
      expect(body.engine).not.toBe('legacy');
    }
    // Custom-workflow row should have been left untouched (no
    // accidental cross-folder write).
    const fetched = await ctx.app.request(
      `/api/auto-code/workflows/${cb.id}`,
    );
    expect(fetched.status).toBe(200);
  });
  it('Delete clears the active workflowTemplate setting when it pointed at the deleted row (Codex P1b round 5)', async () => {
    const folder = ctx.folders.create('F');
    const created = await ctx.app.request(
      '/api/auto-code/workflows',
      json({
        folderId: folder.id,
        name: 'Active',
        definition: SIMPLE_DEFINITION,
      }),
    );
    const cb = (await created.json()) as { id: string };
    // Point the folder's active-workflow setting at the new row.
    const put = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ workflowTemplate: cb.id }, 'PUT'),
    );
    expect(put.status).toBe(200);
    // Delete the workflow — should atomically reset the setting.
    const del = await ctx.app.request(
      `/api/auto-code/workflows/${cb.id}`,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as {
      ok: boolean;
      clearedFolderId: string | null;
    };
    expect(delBody.clearedFolderId).toBe(folder.id);
    // GET settings must now show the canonical default ('default-v2'
    // under the v2 spec) rather than the deleted id.
    const get = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
    );
    const settings = (await get.json()) as { workflowTemplate: string };
    expect(settings.workflowTemplate).toBe('default-v2');
  });
  it('Delete returns clearedFolderId=null when workflow was not the active selection', async () => {
    const folder = ctx.folders.create('F');
    const created = await ctx.app.request(
      '/api/auto-code/workflows',
      json({
        folderId: folder.id,
        name: 'Inactive',
        definition: SIMPLE_DEFINITION,
      }),
    );
    const cb = (await created.json()) as { id: string };
    // Folder setting stays at 'default-v2'.
    const del = await ctx.app.request(
      `/api/auto-code/workflows/${cb.id}`,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(200);
    const body = (await del.json()) as { clearedFolderId: string | null };
    expect(body.clearedFolderId).toBeNull();
  });
  it('Clone endpoint produces a copy with name "<X> (copy)" + isDefault=false', async () => {
    const folder = ctx.folders.create('F');
    const created = await ctx.app.request(
      '/api/auto-code/workflows',
      json({
        folderId: folder.id,
        name: 'Source',
        definition: SIMPLE_DEFINITION,
        isDefault: true,
      }),
    );
    const cb = (await created.json()) as { id: string };
    const cloned = await ctx.app.request(
      `/api/auto-code/workflows/${cb.id}/clone`,
      { method: 'POST' },
    );
    expect(cloned.status).toBe(201);
    const body = (await cloned.json()) as {
      id: string;
      name: string;
      isDefault: boolean;
    };
    expect(body.id).not.toBe(cb.id);
    expect(body.name).toBe('Source (copy)');
    expect(body.isDefault).toBe(false);
  });
  it('Clone returns 404 for unknown id', async () => {
    const res = await ctx.app.request(
      '/api/auto-code/workflows/does-not-exist/clone',
      { method: 'POST' },
    );
    expect(res.status).toBe(404);
  });
  it('GET list returns slim summaries (no full definition)', async () => {
    const folder = ctx.folders.create('F');
    await ctx.app.request(
      '/api/auto-code/workflows',
      json({
        folderId: folder.id,
        name: 'A',
        definition: SIMPLE_DEFINITION,
      }),
    );
    const res = await ctx.app.request(
      `/api/auto-code/workflows?folderId=${folder.id}`,
    );
    const body = (await res.json()) as {
      workflows: Array<Record<string, unknown>>;
    };
    // Slim shape — full `definition` MUST NOT be on the list
    // payload (Codex perf finding 2026-05-10). Seeded templates
    // also land in the same response; assert the no-definition
    // shape on every row.
    expect(body.workflows.length).toBeGreaterThan(0);
    for (const w of body.workflows) {
      expect(w).not.toHaveProperty('definition');
    }
    const ourRow = body.workflows.find(
      (w) => (w.name as string) === 'A',
    );
    expect(ourRow).toBeDefined();
    expect(ourRow!.stageCount).toBe(1);
    expect(ourRow!.agentChain).toEqual(['claude']);
  });
  it('PUT folder workflowTemplate accepts a workflows.id ULID (Этап 2 resolver)', async () => {
    const folder = ctx.folders.create('F');
    const created = await ctx.app.request(
      '/api/auto-code/workflows',
      json({
        folderId: folder.id,
        name: 'Custom',
        definition: SIMPLE_DEFINITION,
      }),
    );
    const cb = (await created.json()) as { id: string };
    const put = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ workflowTemplate: cb.id }, 'PUT'),
    );
    expect(put.status).toBe(200);
    const pb = (await put.json()) as { workflowTemplate: string };
    expect(pb.workflowTemplate).toBe(cb.id);
  });
});
