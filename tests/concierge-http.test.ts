import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activatePro, json, setup, type Ctx } from './helpers/concierge-http-setup.js';
describe('HTTP /api/concierge/folders/:id/settings', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  it('GET returns defaults for a folder without a row', async () => {
    const folder = ctx.folders.create('Project A');
    const res = await ctx.app.request(`/api/concierge/folders/${folder.id}/settings`);
    expect(res.status).toBe(200);
    const s = (await res.json()) as { enabled: boolean };
    // `workflowDefault` field was dropped together with the autonomous
    // tick (ticket `01KQVA65TJ2VCY8VCKH9N5F6W8`, 2026-05-05) — the
    // per-folder workflow textarea was retired in Phase 6.7 v2 and
    // there's no UI consumer left that needs the seed text.
    expect(s.enabled).toBe(false);
  });
  it('PUT succeeds on Pro and persists the patch', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ enabled: true, topicExclusions: 'task management' }, 'PUT'),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as {
      enabled: boolean;
      topicExclusions: string;
    };
    expect(updated.enabled).toBe(true);
    expect(updated.topicExclusions).toBe('task management');
  });
  it('PUT returns 404 for unknown folder', async () => {
    activatePro(ctx.settings);
    const res = await ctx.app.request(
      '/api/concierge/folders/no-such/settings',
      json({ enabled: true }, 'PUT'),
    );
    expect(res.status).toBe(404);
  });
  // -- Auto-code Phase 1 (sub-ticket 01KQEEA0F4EQPQ5VHS69PV4JKJ) ---------
  /**
   * Set up a throwaway directory with a `.git` entry so the route's
   * `validateLinkedRepo` accepts it. We only need the entry to exist;
   * a real `git init` would slow tests down for no extra coverage —
   * the validator itself is path-existence-based, not git-aware.
   */
  function makeRepoLike(): string {
    const dir = mkdtempSync(join(tmpdir(), 'morion-auto-code-repo-'));
    mkdirSync(join(dir, '.git'));
    return dir;
  }
  it('GET defaults expose linkedRepoPath null + autoCodeEnabled false', async () => {
    const folder = ctx.folders.create('P');
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      linkedRepoPath: string | null;
      autoCodeEnabled: boolean;
    };
    expect(body.linkedRepoPath).toBeNull();
    expect(body.autoCodeEnabled).toBe(false);
  });
  it('PUT accepts a valid linked repo path + persists', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const repo = makeRepoLike();
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ linkedRepoPath: repo }, 'PUT'),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { linkedRepoPath: string | null };
    expect(updated.linkedRepoPath).toBe(repo);
  });
  it('PUT rejects a non-existent linked repo path with 422', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ linkedRepoPath: '/tmp/morion-does-not-exist-anywhere' }, 'PUT'),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_linked_repo');
  });
  it('PUT rejects a relative linked repo path with 422', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ linkedRepoPath: 'relative/path' }, 'PUT'),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_linked_repo');
  });
  it('PUT rejects a path that is a file rather than a directory with 422', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const filePath = join(
      mkdtempSync(join(tmpdir(), 'morion-auto-code-not-dir-')),
      'a-file',
    );
    writeFileSync(filePath, 'not a directory');
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ linkedRepoPath: filePath }, 'PUT'),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_linked_repo');
  });
  it('PUT rejects a directory without .git with 422', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const dir = mkdtempSync(join(tmpdir(), 'morion-auto-code-not-git-'));
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ linkedRepoPath: dir }, 'PUT'),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_linked_repo');
  });
  it('PUT refuses autoCodeEnabled=true when no linked_repo_path is set', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ autoCodeEnabled: true }, 'PUT'),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('linked_repo_required');
  });
  it('PUT accepts autoCodeEnabled=true after a valid repo is linked + Mo on', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const repo = makeRepoLike();
    // First call: link the repo + enable Mo (Mo is a prerequisite
    // for auto-code per the orchestrator architecture).
    const link = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ linkedRepoPath: repo, enabled: true }, 'PUT'),
    );
    expect(link.status).toBe(200);
    // Second call: flip the auto-code toggle.
    const toggle = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ autoCodeEnabled: true }, 'PUT'),
    );
    expect(toggle.status).toBe(200);
    const body = (await toggle.json()) as {
      linkedRepoPath: string | null;
      autoCodeEnabled: boolean;
    };
    expect(body.linkedRepoPath).toBe(repo);
    expect(body.autoCodeEnabled).toBe(true);
  });
  it('PUT linkedRepoPath=null clears the link AND blocks autoCodeEnabled', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const repo = makeRepoLike();
    // Link + enable Mo + enable auto-code.
    await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json(
        { linkedRepoPath: repo, enabled: true, autoCodeEnabled: true },
        'PUT',
      ),
    );
    // Clearing the path while toggle is still true should fail (server
    // sees the resulting state has autoCodeEnabled=true + repoPath=null).
    const cleared = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ linkedRepoPath: null }, 'PUT'),
    );
    expect(cleared.status).toBe(422);
    const body = (await cleared.json()) as { error: string };
    expect(body.error).toBe('linked_repo_required');
  });
  it('PUT can clear the link if autoCodeEnabled is flipped off in the same request', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const repo = makeRepoLike();
    await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json(
        { linkedRepoPath: repo, enabled: true, autoCodeEnabled: true },
        'PUT',
      ),
    );
    const cleared = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ linkedRepoPath: null, autoCodeEnabled: false }, 'PUT'),
    );
    expect(cleared.status).toBe(200);
    const body = (await cleared.json()) as {
      linkedRepoPath: string | null;
      autoCodeEnabled: boolean;
    };
    expect(body.linkedRepoPath).toBeNull();
    expect(body.autoCodeEnabled).toBe(false);
  });
  it('Repository round-trips both auto-code fields on a fresh row', () => {
    const folder = ctx.folders.create('P');
    const repo = makeRepoLike();
    ctx.concierge.folderSettings.update(folder.id, {
      enabled: true,
      linkedRepoPath: repo,
      autoCodeEnabled: true,
    });
    const fetched = ctx.concierge.folderSettings.getOrDefault(folder.id);
    expect(fetched.linkedRepoPath).toBe(repo);
    expect(fetched.autoCodeEnabled).toBe(true);
  });
  it('Repository round-trips both auto-code fields on an UPDATE of an existing row', () => {
    const folder = ctx.folders.create('P');
    // First write — INSERT path.
    ctx.concierge.folderSettings.update(folder.id, { enabled: true });
    const repo = makeRepoLike();
    // Second write — UPDATE path. Must merge new fields without
    // dropping the prior `enabled` flag.
    ctx.concierge.folderSettings.update(folder.id, {
      linkedRepoPath: repo,
      autoCodeEnabled: true,
    });
    const fetched = ctx.concierge.folderSettings.getOrDefault(folder.id);
    expect(fetched.linkedRepoPath).toBe(repo);
    expect(fetched.autoCodeEnabled).toBe(true);
    expect(fetched.enabled).toBe(true);
  });
  // -- Workflow template selection (Auto-code Workflow Builder Этап 1) -----
  it('GET surfaces workflowTemplate=default for a row without one', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflowTemplate: string };
    // v2 template id ('default-v2') is the new canonical default
    // surfaced by the settings route (Editor Model spec
    // 01KRAQWPXR5AYTFVF6J12TYHJ1). Legacy 'default' id no longer
    // ships in the registry; resolveWorkflowDefinition falls back
    // to LEGACY_LINEAR for that miss case.
    expect(body.workflowTemplate).toBe('default-v2');
  });
  it('PUT workflowTemplate=code-only-v2 persists + GET reflects it', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const put = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ workflowTemplate: 'code-only-v2' }, 'PUT'),
    );
    expect(put.status).toBe(200);
    const updated = (await put.json()) as { workflowTemplate: string };
    expect(updated.workflowTemplate).toBe('code-only-v2');
    const get = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
    );
    const after = (await get.json()) as { workflowTemplate: string };
    expect(after.workflowTemplate).toBe('code-only-v2');
  });
  it('PUT workflowTemplate=<unknown> returns 422', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ workflowTemplate: 'does-not-exist' }, 'PUT'),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unknown_workflow_template');
  });
  it('GET /api/auto-code/workflow-templates lists templates on Pro', async () => {
    activatePro(ctx.settings);
    const res = await ctx.app.request('/api/auto-code/workflow-templates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      templates: { id: string; label: string; agentChain: string[] }[];
    };
    const ids = body.templates.map((t) => t.id);
    // 5 canonical flows (Mo Workflows epic)
    // in decreasing-complexity order.
    expect(ids).toEqual([
      'plan-and-review-v2',
      'fix-review-docs-qa-v2',
      'fix-review-docs-v2',
      'default-v2',
      'code-only-v2',
    ]);
  });
  // -- Auto-code preflight (sub-ticket 01KQEEARKNH9TE8D008WAX7PQ7) ---------
  it('Preflight route returns 404 for unknown folder', async () => {
    activatePro(ctx.settings);
    const res = await ctx.app.request(
      '/api/concierge/folders/no-such-folder/auto-code/preflight',
    );
    expect(res.status).toBe(404);
  });
  // -- Auto-code toggle-off (sub-ticket 01KQEED9ARX0QZ25S775WDBQC1) -------
  it('Inflight route returns count=0 + empty titles for a fresh folder', async () => {
    const folder = ctx.folders.create('P');
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/auto-code/inflight`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; taskTitles: string[] };
    expect(body.count).toBe(0);
    expect(body.taskTitles).toEqual([]);
  });
  it('Inflight route returns 404 for unknown folder', async () => {
    const res = await ctx.app.request(
      '/api/concierge/folders/no-such-folder/auto-code/inflight',
    );
    expect(res.status).toBe(404);
  });
  it('Toggle-off PATCH returns the cancel summary on enabled→disabled transition', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const repo = makeRepoLike();
    // First: link repo + enable Mo + enable auto-code.
    await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json(
        { linkedRepoPath: repo, enabled: true, autoCodeEnabled: true },
        'PUT',
      ),
    );
    // Now disable. The killer should run + return the summary even
    // though the folder has zero in-flight rows.
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ autoCodeEnabled: false }, 'PUT'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      autoCodeEnabled: boolean;
      autoCodeCancelSummary?: { cancelledCount: number };
    };
    expect(body.autoCodeEnabled).toBe(false);
    expect(body.autoCodeCancelSummary).toBeDefined();
    expect(body.autoCodeCancelSummary!.cancelledCount).toBe(0);
  });
  it('PUT autoCodeEnabled=true with Mo disabled returns 422 mo_required', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const repo = makeRepoLike();
    // First link the repo (needed before autoCodeEnabled can flip).
    await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ linkedRepoPath: repo }, 'PUT'),
    );
    // Now try to enable auto-code without enabling Mo.
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ autoCodeEnabled: true }, 'PUT'),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('mo_required');
  });
  it('PUT enabled=true + autoCodeEnabled=true atomically succeeds', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const repo = makeRepoLike();
    await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ linkedRepoPath: repo }, 'PUT'),
    );
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ enabled: true, autoCodeEnabled: true }, 'PUT'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      autoCodeEnabled: boolean;
    };
    expect(body.enabled).toBe(true);
    expect(body.autoCodeEnabled).toBe(true);
  });
  it('PUT enabled=false cascades autoCodeEnabled to false (Mo orchestrates auto-code)', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const repo = makeRepoLike();
    // Set up: Mo on + auto-code on.
    await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json(
        { linkedRepoPath: repo, enabled: true, autoCodeEnabled: true },
        'PUT',
      ),
    );
    // Disable Mo — auto-code must cascade off + return cancel summary
    // (no in-flight rows in this test, so cancelledCount=0).
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ enabled: false }, 'PUT'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      autoCodeEnabled: boolean;
      autoCodeCancelSummary?: { cancelledCount: number };
    };
    expect(body.enabled).toBe(false);
    expect(body.autoCodeEnabled).toBe(false); // cascaded
    expect(body.autoCodeCancelSummary).toBeDefined();
  });
  it('Toggle-off PATCH does NOT return a cancel summary when already disabled', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    // Folder starts with autoCodeEnabled=false. PATCH to false again
    // is a no-op — no killer should fire.
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/settings`,
      json({ autoCodeEnabled: false }, 'PUT'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { autoCodeCancelSummary?: unknown };
    expect(body.autoCodeCancelSummary).toBeUndefined();
  });
  it('Preflight route returns the full PreflightResult shape', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('P');
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/auto-code/preflight`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      claude: { ready: boolean; path: string | null };
      codex: { ready: boolean };
      mcp: { claude: { installed: boolean }; codex: { installed: boolean } };
      blocking: string[];
    };
    expect(typeof body.claude.ready).toBe('boolean');
    expect(typeof body.codex.ready).toBe('boolean');
    expect(typeof body.mcp.claude.installed).toBe('boolean');
    expect(typeof body.mcp.codex.installed).toBe('boolean');
    // Skills deliberately not part of preflight — see UI for the
    // static "manual install" reminder + parallel sub-ticket
    // 01KQATCMZ5AHY26W1C3M0ZGHG3 for the Skills installer flow.
    expect('skills' in body).toBe(false);
    expect(Array.isArray(body.blocking)).toBe(true);
  });
});
// /api/concierge/folders/:id/launch route removed 2026-05-03 — the
// "Run Mo now" autonomous trigger was dropped per user request along
// with the autonomous per-folder Mo agent.
