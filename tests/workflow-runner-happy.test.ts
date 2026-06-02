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

describe('WorkflowRunner — happy path', () => {
  it('runs every stage in order, marks run done, accumulates cost', async () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult({ summary: 'fix complete', costUsd: 0.5 }) },
      codex: { terminal: makeResult({ summary: 'review approved', costUsd: 0.2 }) },
    });
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: TWO_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    expect(handle.deduped).toBe(false);
    const finalRun = await handle.awaitTerminal();
    expect(finalRun.status).toBe('done');
    expect(finalRun.totalCostUsd).toBeCloseTo(0.7, 5);
    expect(finalRun.lastError).toBeNull();
    expect(finalRun.currentStageId).toBeNull();

    const stages = repo.listStagesForRun(finalRun.id);
    expect(stages.map((s) => s.stageIdInGraph)).toEqual(['fix', 'review']);
    expect(stages.every((s) => s.status === 'done')).toBe(true);
    expect(stages[0].costUsd).toBe(0.5);
    expect(stages[1].costUsd).toBe(0.2);
  });

  it('renders ticket placeholders into the prompt', async () => {
    const { repo } = setup();
    let observedPrompt = '';
    const factory = buildAdapterFactory({
      claude: {
        onSpawn: (opts) => {
          observedPrompt = opts.prompt;
        },
        terminal: makeResult({ costUsd: 0.1 }),
      },
    });
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: ONE_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    await handle.awaitTerminal();
    expect(observedPrompt).toBe('Fix Tetris');
  });

  it('threads stage[N-1] output into stage[N] prompt template', async () => {
    const { repo } = setup();
    let reviewPrompt = '';
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult({ summary: 'diff-XYZ', costUsd: 0.3 }) },
      codex: {
        onSpawn: (opts) => {
          reviewPrompt = opts.prompt;
        },
        terminal: makeResult({ costUsd: 0.1 }),
      },
    });
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: TWO_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    await handle.awaitTerminal();
    expect(reviewPrompt).toBe('Review diff-XYZ');
  });

  it('forwards SpawnOptions: cwd, allowedTools, maxBudgetUsd, transcriptDir', async () => {
    const { repo } = setup();
    let observed: SpawnOptions | null = null;
    const factory = buildAdapterFactory({
      claude: {
        onSpawn: (opts) => {
          observed = opts;
        },
        terminal: makeResult(),
      },
    });
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const h = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: ONE_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    await h.awaitTerminal();
    expect(observed!.cwd).toBe(WORKTREE_PATH);
    expect(observed!.allowedTools).toEqual([]);
    expect(observed!.maxBudgetUsd).toBe(2);
    expect(observed!.transcriptDir).toBe(TRANSCRIPT_DIR);
  });
});

describe('WorkflowRunner — dedupe', () => {
  it('returns deduped handle when an active run already exists', async () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult(), terminalDelay: 80 },
    });
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const first = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: ONE_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const second = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: ONE_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    expect(second.deduped).toBe(true);
    expect(second.runId).toBe(first.runId);
    // Both handles' awaitTerminal resolve with the same final row.
    const [a, b] = await Promise.all([first.awaitTerminal(), second.awaitTerminal()]);
    expect(a.id).toBe(b.id);
    expect(a.status).toBe('done');
  });
});
