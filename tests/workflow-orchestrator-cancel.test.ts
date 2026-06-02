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
 * WorkflowOrchestrator — cancel + recoverStaleRuns delegation
 *
 * Extracted 2026-05-16 from tests/workflow-orchestrator.test.ts
 * (Morion ticket 01KRJZ1DKDRKVAV2YDDZVG3152).
 */

describe('WorkflowOrchestrator — cancel', () => {
  it('cancelTicket no-ops when no active run exists', async () => {
    const ctx = setup();
    const orch = buildOrchestrator(ctx);
    const r = await orch.cancelTicket(ctx.folderId, ctx.ticketId);
    expect(r.cancelledRunId).toBeNull();
  });

  it('cancelTicket flips cancelRequested on the active run', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    // Use a runner whose mock blocks until cancelled — gives us a
    // window to call cancelTicket while the run is alive.
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') => {
      let resolveCancel: () => void = () => {};
      const cancelP = new Promise<void>((r) => {
        resolveCancel = r;
      });
      return {
        name: agent,
        async spawn(opts: SpawnOptions): Promise<AgentHandle> {
          let resolveExited!: () => void;
          const exited = new Promise<void>((r) => {
            resolveExited = r;
          });
          async function* events(): AsyncIterable<CliAgentEvent> {
            try {
              yield {
                kind: 'session_start',
                sessionId: opts.sessionId ?? 'x',
                agent,
                timestamp: Date.now(),
              };
              await cancelP;
              yield {
                kind: 'error',
                errorKind: 'killed',
                message: 'cancelled',
                recoverable: false,
                timestamp: Date.now(),
              };
            } finally {
              resolveExited();
            }
          }
          return {
            adapter: agent,
            sessionId: opts.sessionId ?? 'x',
            pid: 1,
            exited,
            events: events(),
            cancel: async () => {
              resolveCancel();
            },
            resume: async () => {
              throw new Error('not implemented');
            },
            getCost: () => 0,
          };
        },
      } as CliAgentAdapter;
    };
    const runner = new WorkflowRunner({
      repo: ctx.runsRepo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
    });
    const orch = buildOrchestrator(ctx, { runner });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    // Give dispatch a beat to enter the spawn handshake.
    await new Promise((r) => setTimeout(r, 30));
    const r = await orch.cancelTicket(ctx.folderId, ctx.ticketId, 'user_toggle_off');
    expect(r.cancelledRunId).toBe(out.runId);
    const final = await out.handle.awaitTerminal();
    expect(final.status).toBe('cancelled');
  });
});

describe('WorkflowOrchestrator — recoverStaleRuns delegates to runner', () => {
  it('returns runner.recoverStaleRuns() output verbatim', async () => {
    const ctx = setup();
    // Seed an orphan via the repo directly.
    ctx.runsRepo.createRun({
      folderId: ctx.folderId,
      ticketId: ctx.ticketId,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'orphan',
        description: '',
        stages: [
          {
            id: 'a',
            kind: 'cli_agent',
            agent: 'claude',
            promptTemplate: 'a',
            maxBudgetUsd: null,
            maxAttempts: 1,
            allowedTools: [],
          },
        ],
        edges: [],
      },
      repoPath: REPO_PATH,
      worktreePath: `${REPO_PATH}/.morion/worktrees/orphan`,
      initialStatus: 'running',
    });
    const orch = buildOrchestrator(ctx);
    const out = orch.recoverStaleRuns();
    expect(out.recoveredRunIds).toHaveLength(1);
    const fresh = ctx.runsRepo.getRun(out.recoveredRunIds[0]);
    expect(fresh?.status).toBe('failed');
  });

  it('also fires onRunTerminal so the ticket moves to backlog + gets a comment (user feedback 2026-05-19)', async () => {
    const ctx = setup();
    // Move the ticket to `doing` — that's where the runner left it
    // before the sidecar died mid-run.
    ctx.notes.moveToKanban(ctx.ticketId, 'doing', null, 'mcp:auto-code');
    ctx.runsRepo.createRun({
      folderId: ctx.folderId,
      ticketId: ctx.ticketId,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'orphan',
        description: '',
        stages: [
          {
            id: 'a',
            kind: 'cli_agent',
            agent: 'claude',
            promptTemplate: 'a',
            maxBudgetUsd: null,
            maxAttempts: 1,
            allowedTools: [],
          },
        ],
        edges: [],
      },
      repoPath: REPO_PATH,
      worktreePath: `${REPO_PATH}/.morion/worktrees/orphan`,
      initialStatus: 'running',
    });
    const orch = buildOrchestrator(ctx);
    orch.recoverStaleRuns();
    // onRunTerminal is fire-and-forget (microtask). Drain queued
    // microtasks before assertions.
    await Promise.resolve();
    await Promise.resolve();

    // Ticket ejected from `doing` back to `backlog`.
    const note = ctx.notes.getById(ctx.ticketId);
    expect(note?.status).toBe('backlog');
    // A comment was posted explaining why (and includes the
    // humanized "sidecar restarted" copy + raw sentinel).
    const page = ctx.comments.list(ctx.ticketId, { limit: 50 });
    const failureComment = page.items.find((c) =>
      c.body.includes('sidecar restarted'),
    );
    expect(failureComment).toBeDefined();
    expect(failureComment?.body).toContain('interrupted_by_restart');
    // Auto-code-paused tag applied so kanban surfaces stay consistent.
    const refreshed = ctx.notes.getById(ctx.ticketId);
    expect(refreshed?.tags).toContain('auto-code-paused');
  });
});
