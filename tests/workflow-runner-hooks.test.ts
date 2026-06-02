import { describe, expect, it } from 'vitest';

import {
  type BudgetGuard,
  type BudgetGuardContext,
  WorkflowRunner,
} from '../src/core/auto-code/workflows/runner.js';
import { type CliAgentName, type WorkflowDefinition } from '../src/core/auto-code/workflows/types/index.js';
import { parseLinearWorkflow } from '../src/core/auto-code/workflows/parse-linear.js';
import type { SpawnOptions } from '../src/core/auto-code/harness/adapter.js';
import {
  FOLDER_ID,
  MockAdapter,
  ONE_STAGE,
  REPO_PATH,
  TICKET_CTX,
  TICKET_ID,
  TRANSCRIPT_DIR,
  TWO_STAGE,
  WORKTREE_PATH,
  buildAdapterFactory,
  makeError,
  makeResult,
  setup,
} from './workflow-runner/helpers.js';

describe('WorkflowRunner — T7.B.2.a hooks API', () => {
  it('fires onRunStart → onStageStart → onStageEnd → onRunTerminal in order', async () => {
    const ctx = setup();
    const log: string[] = [];
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult({ summary: 'fix done', costUsd: 0.1 }) },
      codex: {
        terminal: makeResult({
          summary: '{"verdict":"approve","reason":"ok"}',
          costUsd: 0.05,
        }),
      },
    });
    const runner = new WorkflowRunner({ repo: ctx.repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: TWO_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
      hooks: {
        onRunStart: (run) => {
          log.push(`onRunStart:${run.status}`);
        },
        onStageStart: ({ stage, attempt }) => {
          log.push(`onStageStart:${stage.id}:attempt${attempt}`);
        },
        onStageEnd: ({ stageRow }) => {
          log.push(`onStageEnd:${stageRow.stageIdInGraph}:${stageRow.status}`);
        },
        onRunTerminal: (run) => {
          log.push(`onRunTerminal:${run.status}`);
        },
      },
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('done');
    expect(log).toEqual([
      'onRunStart:running',
      'onStageStart:fix:attempt1',
      'onStageEnd:fix:done',
      'onStageStart:review:attempt1',
      'onStageEnd:review:done',
      'onRunTerminal:done',
    ]);
  });

  it('hooks see canonical post-write rows (totalCostUsd accumulated by onStageEnd)', async () => {
    const ctx = setup();
    let observedRunCostAtFixEnd = -1;
    let observedRunCostAtReviewEnd = -1;
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult({ summary: 'fix', costUsd: 0.4 }) },
      codex: {
        terminal: makeResult({
          summary: '{"verdict":"approve","reason":"ok"}',
          costUsd: 0.2,
        }),
      },
    });
    const runner = new WorkflowRunner({ repo: ctx.repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: TWO_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
      hooks: {
        onStageEnd: ({ run, stage }) => {
          if (stage.id === 'fix') observedRunCostAtFixEnd = run.totalCostUsd;
          if (stage.id === 'review') observedRunCostAtReviewEnd = run.totalCostUsd;
        },
      },
    });
    await handle.awaitTerminal();
    expect(observedRunCostAtFixEnd).toBeCloseTo(0.4, 5);
    expect(observedRunCostAtReviewEnd).toBeCloseTo(0.6, 5);
  });

  it('hook throws are caught (do not escalate to run failure)', async () => {
    const ctx = setup();
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult() },
    });
    const runner = new WorkflowRunner({ repo: ctx.repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: ONE_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
      hooks: {
        onStageStart: () => {
          throw new Error('hook explosion');
        },
      },
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('done');
  });

  it('async hooks are awaited before next lifecycle event', async () => {
    const ctx = setup();
    const log: string[] = [];
    const factory = buildAdapterFactory({
      claude: {
        onSpawn: () => {
          log.push('spawn');
        },
        terminal: makeResult(),
      },
    });
    const runner = new WorkflowRunner({ repo: ctx.repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: ONE_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
      hooks: {
        onStageStart: async () => {
          await new Promise((r) => setTimeout(r, 30));
          log.push('hook');
        },
      },
    });
    await handle.awaitTerminal();
    // Hook MUST resolve before adapter.spawn fires.
    expect(log).toEqual(['hook', 'spawn']);
  });

  it('onRunTerminal awaited before awaitTerminal() resolves', async () => {
    const ctx = setup();
    const order: string[] = [];
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult() },
    });
    const runner = new WorkflowRunner({ repo: ctx.repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: ONE_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
      hooks: {
        onRunTerminal: async () => {
          await new Promise((r) => setTimeout(r, 30));
          order.push('hook');
        },
      },
    });
    await handle.awaitTerminal();
    order.push('awaitTerminal-resolved');
    expect(order).toEqual(['hook', 'awaitTerminal-resolved']);
  });
});
