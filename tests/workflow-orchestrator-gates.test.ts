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
 * WorkflowOrchestrator — gates (auto_code_enabled / Mo / linkedRepoPath / preflight / agent availability)
 *
 * Extracted 2026-05-16 from tests/workflow-orchestrator.test.ts
 * (Morion ticket 01KRJZ1DKDRKVAV2YDDZVG3152).
 */

describe('WorkflowOrchestrator — gates', () => {
  it('rejects when auto_code_enabled = false', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, { enabled: true, linkedRepoPath: REPO_PATH });
    const orch = buildOrchestrator(ctx);
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.reason).toBe('auto_code_disabled');
  });

  it('rejects when Mo (enabled) = false even if auto_code is on', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    const orch = buildOrchestrator(ctx);
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.reason).toBe('mo_disabled');
  });

  it('rejects when linkedRepoPath is missing', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, { enabled: true, autoCodeEnabled: true });
    const orch = buildOrchestrator(ctx);
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') expect(out.reason).toBe('linked_repo_missing');
  });

  it('rejects when preflight has blocking issues', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    const orch = buildOrchestrator(ctx, {
      preflight: {
        ...STUB_PREFLIGHT_OK,
        blocking: ['claude binary missing on PATH'],
      },
    });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') {
      expect(out.reason).toBe('preflight_blocked');
      expect(out.blocking).toContain('claude binary missing on PATH');
    }
  });

  // Note: the actionability gate (legacy: Claude Haiku "is this
  // ticket detailed enough" pre-flight call) is REMOVED on the
  // workflow runner path. Future L4 editor will surface the same
  // behaviour as a configurable cli_agent[claude] stage with a
  // user-supplied prompt at the start of the workflow definition.

  it('rejects with agent_unavailable when a required agent is missing (Codex P2)', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    // Pretend pi is missing — default-autocode (claude→codex)
    // doesn't need pi, so this should still PASS. Then flip claude
    // off and expect a rejection.
    const orchPiOnly = buildOrchestrator(ctx, {
      isAgentAvailable: (agent) => agent !== 'pi',
    });
    const okOut = await orchPiOnly.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(okOut.kind).toBe('enqueued');

    // Reset the row state by spawning a new orchestrator + folder.
    const ctx2 = setup();
    ctx2.folderSettings.update(ctx2.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    const orchClaudeMissing = buildOrchestrator(ctx2, {
      isAgentAvailable: (agent) => agent !== 'claude',
    });
    const out = await orchClaudeMissing.enqueueTicket(
      ctx2.ticketId,
      ctx2.folderId,
    );
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') {
      expect(out.reason).toBe('agent_unavailable');
      expect(out.missingDetails?.[0]).toMatch(/claude/);
    }
    // Critical: NO workflow_runs row should have been created — the
    // gate fires before claim, so the next legitimate enqueue
    // doesn't trip the partial unique index.
    const active = ctx2.runsRepo.findActiveRunForTicket(
      ctx2.folderId,
      ctx2.ticketId,
    );
    expect(active).toBeNull();
  });
});
