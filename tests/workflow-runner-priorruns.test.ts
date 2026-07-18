import { describe, expect, it } from 'vitest';

import { buildPriorRunsBlock } from '../src/core/auto-code/workflows/prior-runs.js';
import { WorkflowDefinitionSchema } from '../src/core/auto-code/workflows/types/index.js';
import type { WorkflowDefinition } from '../src/core/auto-code/workflows/types/index.js';
import type {
  MoStageDispatcher,
  MoStageDispatchInput,
} from '../src/core/auto-code/workflows/mo-stage-dispatcher.js';
import { WorkflowRunner } from '../src/core/auto-code/workflows/runner.js';
import {
  REPO_PATH,
  TRANSCRIPT_DIR,
  buildOrchestrator,
  setup,
  type Ctx,
} from './helpers/workflow-orchestrator-setup.js';

/**
 * Cross-run memory — "Mo = router, not narrator" epic.
 *
 * Part 1: `buildPriorRunsBlock` unit contract against repo fixtures.
 * Part 2: admission wires `{{ticket.priorRuns}}` — the second run's
 * mo_start decision sees the first run's reject reason.
 */

const GRAPH: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: 1,
  name: 'gate-only',
  stages: [
    {
      id: 'start',
      kind: 'mo_stage',
      instruction: 'gate',
      branches: ['approve', 'reject'],
      isStart: true,
      postComment: true,
      allowedTools: null,
    },
    { id: 'reject_t', kind: 'reject_sink', commentTemplate: '' },
    { id: 'complete_t', kind: 'complete_sink', commentTemplate: '' },
  ],
  edges: [
    { from: 'start', to: 'complete_t', on: 'approve' },
    { from: 'start', to: 'reject_t', on: 'reject' },
  ],
});

function seedTerminalRun(
  ctx: Ctx,
  opts: {
    status: 'done' | 'failed' | 'cancelled';
    lastError?: string;
    stageSummary?: string;
    diffstat?: string;
    finishedAt: number;
  },
): string {
  const claim = ctx.runsRepo.createRun(
    {
      folderId: ctx.folderId,
      ticketId: ctx.ticketId,
      graphSnapshot: GRAPH,
      repoPath: REPO_PATH,
      worktreePath: `${REPO_PATH}/.morion/worktrees/auto-${opts.finishedAt}`,
    },
    opts.finishedAt - 1_000,
  );
  if (claim.deduped) throw new Error('run unexpectedly deduped');
  const runId = claim.run.id;
  if (opts.stageSummary) {
    const stage = ctx.runsRepo.createStage(
      {
        runId,
        stageIdInGraph: 'fix',
        stageKind: 'cli_agent',
        agentName: 'claude',
        transcriptPath: `${TRANSCRIPT_DIR}/sess-${opts.finishedAt}.jsonl`,
      },
      opts.finishedAt - 900,
    );
    ctx.runsRepo.updateStage(
      stage.id,
      {
        status: 'done',
        finishedAt: opts.finishedAt - 500,
        output: {
          summary: opts.stageSummary,
          ...(opts.diffstat ? { diffstat: opts.diffstat } : {}),
        },
      },
      opts.finishedAt - 500,
    );
  }
  ctx.runsRepo.updateRun(
    runId,
    {
      status: opts.status,
      lastError: opts.lastError ?? null,
      finishedAt: opts.finishedAt,
    },
    opts.finishedAt,
  );
  return runId;
}

describe('buildPriorRunsBlock', () => {
  it('digests terminal runs newest-first with outcome, stage facts, and transcript pointers', () => {
    const ctx = setup();
    const oldRun = seedTerminalRun(ctx, {
      status: 'failed',
      lastError: 'rejected_by_workflow: OLD-RUN-REASON',
      stageSummary: 'old attempt summary',
      finishedAt: Date.now() - 60_000,
    });
    const newRun = seedTerminalRun(ctx, {
      status: 'failed',
      lastError: 'rejected_by_workflow: reviewer said "missing wall-kick"',
      stageSummary: 'implemented rotation only',
      diffstat: ' game.js | 12 ++++',
      finishedAt: Date.now(),
    });

    const block = buildPriorRunsBlock(ctx.runsRepo, ctx.ticketId);
    expect(block).toContain('## Previous auto-code runs');
    // Newest first.
    expect(block.indexOf(newRun)).toBeLessThan(block.indexOf(oldRun));
    expect(block).toContain('missing wall-kick');
    expect(block).toContain('implemented rotation only');
    expect(block).toContain('game.js | 12');
    expect(block).toContain(`transcript: ${TRANSCRIPT_DIR}/`);
    expect(block).toContain('OLD-RUN-REASON');
  });

  it('caps at 3 newest terminal runs, skips active runs and excludeRunId', () => {
    const ctx = setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        seedTerminalRun(ctx, {
          status: 'done',
          lastError: `RUN-MARK-${i}`,
          finishedAt: Date.now() - (5 - i) * 10_000,
        }),
      );
    }
    // An active (non-terminal) run must never appear.
    const active = ctx.runsRepo.createRun(
      {
        folderId: ctx.folderId,
        ticketId: ctx.ticketId,
        graphSnapshot: GRAPH,
        repoPath: REPO_PATH,
        worktreePath: `${REPO_PATH}/.morion/worktrees/auto-live`,
      },
      Date.now(),
    );

    const block = buildPriorRunsBlock(ctx.runsRepo, ctx.ticketId, {
      excludeRunId: ids[4],
    });
    // Excluded + only 3 newest of the remaining terminal runs.
    expect(block).not.toContain(`RUN-MARK-4`);
    expect(block).toContain(`RUN-MARK-3`);
    expect(block).toContain(`RUN-MARK-2`);
    expect(block).toContain(`RUN-MARK-1`);
    expect(block).not.toContain(`RUN-MARK-0`);
    expect(block).not.toContain(active.run.id);
  });

  it('returns an empty string when the ticket has no terminal runs', () => {
    const ctx = setup();
    expect(buildPriorRunsBlock(ctx.runsRepo, ctx.ticketId)).toBe('');
  });

  it('truncates one run digest at the per-run cap without losing the outcome line', () => {
    const ctx = setup();
    seedTerminalRun(ctx, {
      status: 'failed',
      lastError: 'rejected_by_workflow: THE-OUTCOME-LINE',
      stageSummary: 'x'.repeat(10_000),
      finishedAt: Date.now(),
    });
    const block = buildPriorRunsBlock(ctx.runsRepo, ctx.ticketId);
    expect(block).toContain('THE-OUTCOME-LINE');
    expect(block.length).toBeLessThan(4_500);
  });
});

describe('admission wires {{ticket.priorRuns}}', () => {
  it("second run's mo_start decision scope carries the first run's reject reason", async () => {
    const ctx = setup();
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: REPO_PATH,
    });

    const seenPriorRuns: string[] = [];
    const rejectingDispatcher: MoStageDispatcher = {
      async decide(input: MoStageDispatchInput) {
        seenPriorRuns.push(
          typeof input.ticket.priorRuns === 'string'
            ? input.ticket.priorRuns
            : '(missing)',
        );
        return {
          ok: true,
          branch: 'reject',
          reason: 'spec cites "no acceptance criteria" — rejecting',
          costUsd: 0,
        };
      },
    };
    const orch = buildOrchestrator(ctx, {
      runner: new WorkflowRunner({
        repo: ctx.runsRepo,
        adapterFactory: () => {
          throw new Error('no cli stages in this graph');
        },
        transcriptDir: TRANSCRIPT_DIR,
        moStageDispatcher: rejectingDispatcher,
      }),
      resolveDefinition: () => GRAPH,
    });

    const first = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    if (first.kind !== 'enqueued') throw new Error('expected enqueued');
    await first.handle.awaitTerminal();

    // The reject sink parked the ticket in backlog — re-drag to todo
    // exactly like the user retrying the ticket.
    ctx.notes.update(ctx.ticketId, { status: 'todo' }, 'user');

    const second = await orch.enqueueTicket(ctx.ticketId, ctx.folderId);
    if (second.kind !== 'enqueued')
      throw new Error(`expected enqueued, got ${JSON.stringify(second)}`);
    await second.handle.awaitTerminal();

    // First run: no history. Second run: the first run's digest with
    // Mo's evidence-quoted reject reason, verbatim.
    expect(seenPriorRuns[0]).toBe('');
    expect(seenPriorRuns[1]).toContain('## Previous auto-code runs');
    expect(seenPriorRuns[1]).toContain('no acceptance criteria');
  });
});
