import { describe, it, expect } from 'vitest';

import { getOrCreateWorkflowRunner } from '../src/server/features/auto-code-factory/runner-singleton.js';
import { WorkflowRunner } from '../src/core/auto-code/workflows/runner.js';
import {
  REPO_PATH,
  TRANSCRIPT_DIR,
  setup,
  makeRunner,
  buildOrchestrator,
  type Ctx,
} from './helpers/workflow-orchestrator-setup.js';
import type {
  AgentHandle,
  CliAgentAdapter,
  SpawnOptions,
} from '../src/core/auto-code/harness/adapter.js';
import type { CliAgentEvent } from '../src/core/auto-code/harness/events.js';

/**
 * Regression for "auto-stop of
 * auto-code is not working". The live cli_agent adapter handle lives in
 * the `states` map of the WorkflowRunner that STARTED the run. Because
 * `buildWorkflowOrchestrator` was a per-request factory, a cancel issued
 * from a later request (kanban drag → backlog, or a Stop button) minted a
 * FRESH runner with an empty `states` map: it flipped the DB
 * `cancelRequested` flag but never signalled the live handle, so the
 * in-flight (expensive) cli_agent stage ran to completion — burning budget.
 *
 * The fix makes the runner a process singleton keyed by the DB handle, so
 * every request shares one runner and cancel always reaches the live run.
 */

/** Adapter whose event stream blocks until its handle's `cancel()` fires,
 *  recording how many times the live handle was signalled. */
function makeBlockingAdapterFactory() {
  const state = { cancelCalls: 0 };
  const factory = ((agent: 'claude' | 'codex' | 'pi' | 'opencode') => ({
    name: agent,
    async spawn(opts: SpawnOptions): Promise<AgentHandle> {
      let resolveCancel: () => void = () => {};
      const cancelP = new Promise<void>((r) => {
        resolveCancel = r;
      });
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
          await cancelP; // stall here until the handle is cancelled
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
          state.cancelCalls++;
          resolveCancel();
        },
        resume: async () => {
          throw new Error('not implemented');
        },
        getCost: () => 0,
      };
    },
  })) as unknown as (agent: 'claude' | 'codex' | 'pi' | 'opencode') => CliAgentAdapter;
  return { factory, state };
}

function makeRunnerWith(
  ctx: Ctx,
  factory: (agent: 'claude' | 'codex' | 'pi' | 'opencode') => CliAgentAdapter,
): WorkflowRunner {
  return new WorkflowRunner({
    repo: ctx.runsRepo,
    adapterFactory: factory,
    transcriptDir: TRANSCRIPT_DIR,
  });
}

describe('getOrCreateWorkflowRunner — process singleton per DB', () => {
  it('returns the same runner for the same db key, builds once', () => {
    const ctx = setup();
    let builds = 0;
    const build = () => {
      builds++;
      return makeRunner(ctx);
    };
    const a1 = getOrCreateWorkflowRunner(ctx.db, build);
    const a2 = getOrCreateWorkflowRunner(ctx.db, build);
    expect(a1).toBe(a2);
    expect(builds).toBe(1);
  });

  it('returns a distinct runner for a distinct db key (test isolation)', () => {
    const ctxA = setup();
    const ctxB = setup();
    const a = getOrCreateWorkflowRunner(ctxA.db, () => makeRunner(ctxA));
    const b = getOrCreateWorkflowRunner(ctxB.db, () => makeRunner(ctxB));
    expect(a).not.toBe(b);
  });
});

describe('auto-stop cancel must reach the live adapter handle', () => {
  it('a cancel from a DIFFERENT runner instance flips the DB flag but never kills the process (the bug)', async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });
    const { factory, state } = makeBlockingAdapterFactory();
    const runnerA = makeRunnerWith(ctx, factory); // started the run
    const runnerB = makeRunnerWith(ctx, factory); // a fresh per-request runner
    const orchA = buildOrchestrator(ctx, { runner: runnerA });
    const orchB = buildOrchestrator(ctx, { runner: runnerB });

    const out = await orchA.enqueueTicket(ctx.ticketId, ctx.folderId);
    if (out.kind !== 'enqueued') throw new Error('expected enqueued');
    await new Promise((r) => setTimeout(r, 30)); // let the spawn handshake settle

    // Cancel via runnerB (empty states): finds the run row, flips the DB
    // flag — but the live handle held by runnerA is NEVER signalled.
    const rB = await orchB.cancelTicket(ctx.folderId, ctx.ticketId, 'user_toggle_off');
    expect(rB.cancelledRunId).toBe(out.runId);
    expect(ctx.runsRepo.getRun(out.runId)?.cancelRequested).toBe(true);
    expect(state.cancelCalls).toBe(0); // <-- process kept running: the bug

    // Cancel via runnerA (what the singleton guarantees every request
    // gets): the live handle IS signalled and the run terminates.
    await orchA.cancelTicket(ctx.folderId, ctx.ticketId, 'user_toggle_off');
    expect(state.cancelCalls).toBe(1);
    const final = await out.handle.awaitTerminal();
    expect(final.status).toBe('cancelled');
  });
});
