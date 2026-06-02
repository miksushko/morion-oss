import { describe, expect, it } from 'vitest';

import { WorkflowOrchestrator } from '../src/core/auto-code/workflows/workflow-orchestrator.js';
import { parseLinearWorkflow } from '../src/core/auto-code/workflows/parse-linear.js';
import { WorkflowDefinitionSchema } from '../src/core/auto-code/workflows/types/index.js';
import { LEGACY_LINEAR_AUTOCODE_DEFINITION } from '../src/core/auto-code/workflows/default-autocode.js';
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
 * WorkflowOrchestrator — dispatch (DAG admission + happy path + Codex round 3 resolver workflowId)
 *
 * Extracted 2026-05-16 from tests/workflow-orchestrator.test.ts
 * (Morion ticket 01KRJZ1DKDRKVAV2YDDZVG3152).
 */

describe('WorkflowOrchestrator — Phase 4 DAG dispatch admission', () => {
  it('enqueues v2 (mo_stage) workflows now that the DAG runner ships', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    const v2Draft = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'v2-draft-template',
      stages: [
        {
          id: 'start',
          kind: 'mo_stage',
          instruction: '',
          branches: ['approve', 'reject'],
          isStart: true,
          postComment: true,
          allowedTools: null,
        },
        { id: 'reject', kind: 'reject_sink', commentTemplate: '' },
        { id: 'complete', kind: 'complete_sink', commentTemplate: '' },
      ],
      edges: [
        { from: 'start', to: 'complete', on: 'approve' },
        { from: 'start', to: 'reject', on: 'reject' },
      ],
    });
    const orch = buildOrchestrator(ctx, {
      resolveDefinition: () => v2Draft,
    });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('enqueued');
    if (out.kind === 'enqueued') {
      // Default MoStageDispatcher fails clean — run terminates as
      // `failed` with `mo_stage_failed:mo_stage_dispatcher_not_wired`
      // when no Mo backend is injected.
      const final = await out.handle.awaitTerminal();
      expect(final.status).toBe('failed');
      expect(final.lastError ?? '').toMatch(/mo_stage_dispatcher_not_wired/);
    }
  });

  it('admits human_gate workflows now that Phase 5 runtime is shipped (was rejected as workflow_not_runnable through Phase 4)', async () => {
    // Phase 5 MVP (ticket 01KRFT0742GY480WFJTAW02Z05) — parser now
    // whitelists human_gate, runner pauses + resumes on user reply.
    // Workflows with human_gate enqueue normally; pause-on-stage is
    // covered by the runner-level tests in
    // workflow-runner-human-gate.test.ts.
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    const draftWithHumanGate = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'human-gate-draft',
      stages: [
        {
          id: 'start',
          kind: 'mo_stage',
          instruction: '',
          branches: ['ask', 'reject'],
          isStart: true,
          postComment: true,
          allowedTools: null,
        },
        { id: 'human', kind: 'human_gate', prompt: 'reply please' },
        { id: 'reject', kind: 'reject_sink', commentTemplate: '' },
        { id: 'complete', kind: 'complete_sink', commentTemplate: '' },
      ],
      edges: [
        { from: 'start', to: 'human', on: 'ask' },
        { from: 'start', to: 'reject', on: 'reject' },
        { from: 'human', to: 'complete', on: '' },
      ],
    });
    const orch = buildOrchestrator(ctx, {
      resolveDefinition: () => draftWithHumanGate,
    });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('enqueued');
  });
});

describe('WorkflowOrchestrator — happy path', () => {
  it('all gates pass → starts a workflow_run and returns the handle', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    const orch = buildOrchestrator(ctx);
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('enqueued');
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    expect(out.deduped).toBe(false);
    const final = await out.handle.awaitTerminal();
    expect(final.status).toBe('done');
    expect(final.repoPath).toBe(REPO_PATH);
    expect(final.worktreePath).toBe(
      `${REPO_PATH}/.morion/worktrees/auto-fixed-test-id`,
    );
  });

  it('forwards rendered ticket context into the fix-stage prompt', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    let observedFixPrompt = '';
    let observedReviewPrompt = '';
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') => {
      const isFix = agent === 'claude';
      return new MockAdapter(agent, {
        onSpawn: (opts) => {
          if (isFix) observedFixPrompt = opts.prompt;
          else observedReviewPrompt = opts.prompt;
        },
        terminal: {
          kind: 'result',
          exitCode: 0,
          summary: isFix
            ? 'fix produced a diff'
            : '{"verdict":"approve","reason":"ok"}',
          costUsd: 0.1,
          terminalReason: 'completed',
          timestamp: Date.now(),
        },
      });
    };
    const runner = new WorkflowRunner({
      repo: ctx.runsRepo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
    });
    const orch = buildOrchestrator(ctx, { runner });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    await out.handle.awaitTerminal();
    expect(observedFixPrompt).toMatch(/Build a tetris page/);
    expect(observedFixPrompt).toMatch(/Acceptance criteria/);
    expect(observedReviewPrompt).toMatch(/fix produced a diff/);
  });

  it('dedupe — second enqueue returns the same runId with deduped=true', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    // Slow runner so the first run is still active when the second
    // enqueue arrives.
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') =>
      new MockAdapter(agent, {
        terminal: {
          kind: 'result',
          exitCode: 0,
          summary: agent === 'codex' ? '{"verdict":"approve","reason":"ok"}' : 'fix',
          costUsd: 0.1,
          terminalReason: 'completed',
          timestamp: Date.now(),
        },
      });
    const slowRunner = new WorkflowRunner({
      repo: ctx.runsRepo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
    });
    const orch = buildOrchestrator(ctx, { runner: slowRunner });
    const first = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    const second = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    if (first.kind !== 'enqueued' || second.kind !== 'enqueued') {
      throw new Error('expected both enqueued');
    }
    expect(second.runId).toBe(first.runId);
    expect(second.deduped).toBe(true);
    await Promise.all([first.handle.awaitTerminal(), second.handle.awaitTerminal()]);
  });
});

describe('WorkflowOrchestrator — Codex round 3: resolver workflowId + stale-fallback', () => {
  it('persists resolver.workflowId on workflow_runs.workflow_id (Codex P2a)', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    const customId = '01CUSTOMWORKFLOWIDVALIDULID';
    const orch = buildOrchestrator(ctx, {
      resolveDefinition: () => ({
        definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
        workflowId: customId,
      }),
    });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('enqueued');
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    const run = ctx.runsRepo.getRun(out.runId);
    expect(run?.workflowId).toBe(customId);
  });

  it('resolver returning bare WorkflowDefinition still works (legacy single-arg shim)', async () => {
    // Pre-Этап 2 callers passed `(folderId) => def`. The orchestrator
    // normalises to `{definition, workflowId: null}` so existing
    // callers don't break.
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    const orch = buildOrchestrator(ctx, {
      resolveDefinition: (() => LEGACY_LINEAR_AUTOCODE_DEFINITION) as never,
    });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('enqueued');
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    const run = ctx.runsRepo.getRun(out.runId);
    expect(run?.workflowId).toBeNull();
  });

  it('resolver returning workflowId=null leaves workflow_runs.workflow_id null (built-in template path)', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    const orch = buildOrchestrator(ctx, {
      resolveDefinition: () => ({
        definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
        workflowId: null,
      }),
    });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('enqueued');
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    const run = ctx.runsRepo.getRun(out.runId);
    expect(run?.workflowId).toBeNull();
  });
});
