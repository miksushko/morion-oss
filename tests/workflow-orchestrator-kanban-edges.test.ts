import { describe, expect, it } from 'vitest';

import { WorkflowOrchestrator } from '../src/core/auto-code/workflows/workflow-orchestrator.js';
import { WorkflowRunner } from '../src/core/auto-code/workflows/runner.js';
import type { CliAgentAdapter } from '../src/core/auto-code/harness/adapter.js';

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
import {
  setupWithKanban,
  buildHappyFactory,
} from './helpers/workflow-orchestrator-kanban-setup.js';

/**
 * WorkflowOrchestrator — T7.B.2.b kanban moves + Mo comments (guards + lifecycle edges)
 *
 * Lifecycle guards: stale enqueue rejection, pre-runner dedupe (P1.2), fix→review move (P1.3), reopen→doing (P1.3), cancelled run preserves user intent (no move).
 *
 * Extracted 2026-05-16 from tests/workflow-orchestrator-kanban.test.ts
 * as part of the kanban describe split (Morion ticket
 * 01KRJZ1DKDRKVAV2YDDZVG3152, second pass).
 */

describe('WorkflowOrchestrator — T7.B.2.b kanban moves + Mo comments (guards + lifecycle edges)', () => {
  it('stale enqueue: ticket left `todo` before run starts → rejected, no kanban move (P1.1)', async () => {
    const ctx = setupWithKanban();
    // Simulate "user dragged card OUT of todo between trigger and
    // async enqueue arrival" — flip the status to backlog before
    // the orchestrator's stale-check fires.
    ctx.notes.moveToKanban(ctx.ticketId, 'backlog', null, 'user');
    let claudeSpawned = 0;
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') => {
      claudeSpawned += 1;
      return new MockAdapter(agent, { terminal: makeResult() });
    };
    const runner = new WorkflowRunner({
      repo: ctx.runsRepo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
    });
    let ensureWorktreeCalls = 0;
    const orch = new WorkflowOrchestrator({
      db: ctx.db,
      notes: ctx.notes,
      folders: ctx.folders,
      comments: ctx.comments,
      audit: ctx.audit,
      folderSettings: ctx.folderSettings,
      runsRepo: ctx.runsRepo,
      runner,
      preflightImpl: () => STUB_PREFLIGHT_OK,
      ensureWorktree: async () => {
        ensureWorktreeCalls += 1;
      },
      generateWorktreeName: () => 'auto-fixed-test-id',
    });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') {
      expect(out.reason).toBe('ticket_no_longer_todo');
      expect(out.missingDetails?.[0]).toMatch(/backlog/);
    }
    // No worktree creation, no claude spawn — the
    // run never started.
    expect(ensureWorktreeCalls).toBe(0);
    expect(claudeSpawned).toBe(0);
    // Card stays in backlog where the user put it.
    expect(ctx.notes.getById(ctx.ticketId)?.status).toBe('backlog');
  });

  it('pre-runner dedupe: second enqueue does NOT call ensureWorktree (P1.2)', async () => {
    const ctx = setupWithKanban();
    let ensureWorktreeCalls = 0;
    // First run — held open via slow terminal so the second enqueue
    // observes it as active.
    let firstResolve: () => void = () => {};
    const firstHeld = new Promise<void>((r) => {
      firstResolve = r;
    });
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') => ({
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
            await firstHeld;
            yield {
              kind: 'result',
              exitCode: 0,
              summary:
                agent === 'codex' ? '{"verdict":"approve","reason":"ok"}' : 'fix',
              costUsd: 0.1,
              terminalReason: 'completed',
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
          cancel: async () => {},
          resume: async () => {
            throw new Error('not impl');
          },
          getCost: () => 0.1,
        };
      },
    } as CliAgentAdapter);
    const runner = new WorkflowRunner({
      repo: ctx.runsRepo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
    });
    const orch = new WorkflowOrchestrator({
      db: ctx.db,
      notes: ctx.notes,
      folders: ctx.folders,
      comments: ctx.comments,
      audit: ctx.audit,
      folderSettings: ctx.folderSettings,
      runsRepo: ctx.runsRepo,
      runner,
      preflightImpl: () => STUB_PREFLIGHT_OK,
      ensureWorktree: async () => {
        ensureWorktreeCalls += 1;
      },
      generateWorktreeName: () => 'auto-fixed-test-id',
    });
    const first = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    if (first.kind !== 'enqueued') throw new Error('expected enqueued');
    expect(first.deduped).toBe(false);
    expect(ensureWorktreeCalls).toBe(1);
    // Wait for onRunStart hook to land.
    await new Promise((r) => setTimeout(r, 30));

    // Second enqueue — must short-circuit on dedupe BEFORE ensureWorktree.
    const second = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    if (second.kind !== 'enqueued') throw new Error('expected enqueued');
    expect(second.deduped).toBe(true);
    expect(second.runId).toBe(first.runId);
    expect(ensureWorktreeCalls).toBe(1); // unchanged

    firstResolve();
    await first.handle.awaitTerminal();
  });

  it('fix → review boundary moves the card to review (P1.3)', async () => {
    const ctx = setupWithKanban();
    let observedStatusAtReviewSpawn: string | null = null;
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') => {
      if (agent === 'claude') {
        return new MockAdapter(agent, {
          terminal: makeResult({ summary: 'fix done', costUsd: 0.3 }),
        });
      }
      // codex (review)
      return new MockAdapter(agent, {
        onSpawn: () => {
          // Snapshot kanban status at the moment review spawns —
          // should already be 'review' thanks to onStageEnd hook.
          observedStatusAtReviewSpawn = ctx.notes.getById(ctx.ticketId)?.status ?? null;
        },
        terminal: makeResult({
          summary: '{"verdict":"approve","reason":"ok"}',
          costUsd: 0.05,
        }),
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
    expect(observedStatusAtReviewSpawn).toBe('review');
  });

  it('reopen attempt > 1 moves the card back to doing (P1.3)', async () => {
    const ctx = setupWithKanban();
    const fixCallStatuses: string[] = [];
    let reviewCalls = 0;
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') => {
      if (agent === 'claude') {
        return new MockAdapter(agent, {
          onSpawn: () => {
            fixCallStatuses.push(
              ctx.notes.getById(ctx.ticketId)?.status ?? '?',
            );
          },
          terminal: makeResult({ summary: 'fix iteration', costUsd: 0.1 }),
        });
      }
      reviewCalls += 1;
      // First review reopens; second approves.
      return new MockAdapter(agent, {
        terminal: makeResult({
          summary:
            reviewCalls === 1
              ? '{"verdict":"reopen","reason":"missing tests"}'
              : '{"verdict":"approve","reason":"ok"}',
          costUsd: 0.05,
        }),
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
    const final = await out.handle.awaitTerminal();
    expect(final.status).toBe('done');
    // Two fix attempts. First spawn observes 'doing' (onRunStart
    // already moved); second spawn observes 'doing' again (the
    // onStageStart hook for fix attempt > 1 moved review → doing).
    expect(fixCallStatuses).toEqual(['doing', 'doing']);
  });

  it('cancelled run: NO kanban move (preserves user intent)', async () => {
    const ctx = setupWithKanban();
    let resolveSpawn: () => void = () => {};
    const spawnHeld = new Promise<void>((r) => {
      resolveSpawn = r;
    });
    const factory = (agent: 'claude' | 'codex' | 'pi' | 'opencode') => ({
      name: agent,
      async spawn(opts: SpawnOptions): Promise<AgentHandle> {
        let resolveExited!: () => void;
        const exited = new Promise<void>((r) => {
          resolveExited = r;
        });
        let cancelled = false;
        async function* events(): AsyncIterable<CliAgentEvent> {
          try {
            yield {
              kind: 'session_start',
              sessionId: opts.sessionId ?? 'x',
              agent,
              timestamp: Date.now(),
            };
            await spawnHeld;
            if (cancelled) {
              yield {
                kind: 'error',
                errorKind: 'killed',
                message: 'cancelled',
                recoverable: false,
                timestamp: Date.now(),
              };
            }
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
            cancelled = true;
            resolveSpawn();
          },
          resume: async () => {
            throw new Error('not impl');
          },
          getCost: () => 0,
        };
      },
    } as CliAgentAdapter);
    const runner = new WorkflowRunner({
      repo: ctx.runsRepo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
    });
    const orch = buildOrchestrator(ctx, { runner });
    const out = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    // Onrunstart already moved todo→doing.
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.notes.getById(ctx.ticketId)?.status).toBe('doing');
    await orch.cancelTicket(ctx.folderId, ctx.ticketId, 'user_toggle_off');
    const final = await out.handle.awaitTerminal();
    expect(final.status).toBe('cancelled');
    // Card should remain in 'doing' — cancelled branch does NOT move
    // the kanban (user's own move/toggle drove the cancel).
    expect(ctx.notes.getById(ctx.ticketId)?.status).toBe('doing');
    const page = ctx.comments.list(ctx.ticketId, { limit: 50 });
    const lastMo = page.items.find((c) => c.actor === 'mcp:auto-code');
    expect(lastMo?.body).toMatch(/Auto-code cancelled/i);
  });
});
