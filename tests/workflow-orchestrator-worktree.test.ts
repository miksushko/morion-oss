import { describe, expect, it } from 'vitest';

import { WorkflowOrchestrator } from '../src/core/auto-code/workflows/workflow-orchestrator.js';

import {
  REPO_PATH,
  STUB_PREFLIGHT_OK,
  TICKET_TITLE,
  TICKET_BODY,
  TRANSCRIPT_DIR,
  buildOrchestrator,
  makeResult,
  makeRunner,
  setup,
  MockAdapter,
  type Ctx,
} from './helpers/workflow-orchestrator-setup.js';
import { WorkflowRunner } from '../src/core/auto-code/workflows/runner.js';

/**
 * WorkflowOrchestrator — T7.A review regressions (worktree_setup_failed + folder_cap_exceeded)
 *
 * Extracted 2026-05-16 from tests/workflow-orchestrator.test.ts
 * (Morion ticket 01KRJZ1DKDRKVAV2YDDZVG3152).
 */

describe('WorkflowOrchestrator — Codex T7.A review regressions', () => {
  // P1 — worktree must exist before runner.start spawns the adapter.
  it('rejects with worktree_setup_failed when ensureWorktree throws', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    const orch = buildOrchestrator(ctx, {
      ensureWorktreeThrows: new Error('git worktree add failed: ENOENT'),
    });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') {
      expect(out.reason).toBe('worktree_setup_failed');
      expect(out.missingDetails?.[0]).toMatch(/git worktree add/);
    }
  });

  it('runner is NOT called when worktree setup fails', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    let runnerStartCalled = false;
    const fakeRunner = {
      start: async () => {
        runnerStartCalled = true;
        return {} as never;
      },
      cancel: async () => {},
      recoverStaleRuns: () => ({ recoveredRunIds: [] }),
    } as unknown as WorkflowRunner;
    const orch = buildOrchestrator(ctx, {
      runner: fakeRunner,
      ensureWorktreeThrows: new Error('boom'),
    });
    await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(runnerStartCalled).toBe(false);
  });

  // P1 — per-folder concurrency cap.
  it('rejects with folder_cap_exceeded when MAX_INFLIGHT runs are already active', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    // Seed two distinct active runs in the folder via the repo
    // directly (other tickets, so the per-ticket dedupe doesn't
    // collapse them).
    const t2 = ctx.notes.create(
      { body: '# T2', folderId: ctx.folderId, source: 'user' },
      'user',
    );
    const t3 = ctx.notes.create(
      { body: '# T3', folderId: ctx.folderId, source: 'user' },
      'user',
    );
    const minimalSnapshot = {
      schemaVersion: 1 as const,
      name: 'seed',
      description: '',
      stages: [
        {
          id: 'a',
          kind: 'cli_agent' as const,
          agent: 'claude' as const,
          promptTemplate: 'a',
          maxBudgetUsd: null,
          maxAttempts: 1,
          allowedTools: [] as string[],
        },
      ],
      edges: [],
    };
    ctx.runsRepo.createRun({
      folderId: ctx.folderId,
      ticketId: t2.id,
      graphSnapshot: minimalSnapshot,
      repoPath: REPO_PATH,
      worktreePath: `${REPO_PATH}/.morion/worktrees/x2`,
      initialStatus: 'running',
    });
    ctx.runsRepo.createRun({
      folderId: ctx.folderId,
      ticketId: t3.id,
      graphSnapshot: minimalSnapshot,
      repoPath: REPO_PATH,
      worktreePath: `${REPO_PATH}/.morion/worktrees/x3`,
      initialStatus: 'running',
    });

    const orch = buildOrchestrator(ctx, { maxInflightPerFolder: 2 });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') {
      expect(out.reason).toBe('folder_cap_exceeded');
      expect(out.missingDetails?.[0]).toMatch(/2 active runs.*cap 2/);
    }
  });

  it('cap permits enqueue when inflight is below the cap', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    const orch = buildOrchestrator(ctx, { maxInflightPerFolder: 5 });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('enqueued');
  });
});
