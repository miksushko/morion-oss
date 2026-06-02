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

describe('WorkflowRunner — T5 budget guard pre-flight', () => {
  it('default (no guard supplied) lets every stage spawn', async () => {
    const { repo } = setup();
    let spawned = 0;
    const factory = buildAdapterFactory({
      claude: {
        onSpawn: () => {
          spawned += 1;
        },
        terminal: makeResult({ costUsd: 0.1 }),
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
    const final = await h.awaitTerminal();
    expect(final.status).toBe('done');
    expect(spawned).toBe(1);
  });

  it('denied verdict short-circuits the stage with failed + reason', async () => {
    const { repo } = setup();
    let spawned = 0;
    const factory = buildAdapterFactory({
      claude: {
        onSpawn: () => {
          spawned += 1;
        },
        terminal: makeResult(),
      },
    });
    const guard: BudgetGuard = {
      check: () => ({ allow: false, reason: 'workspace_cap_exhausted' }),
    };
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
      budgetGuard: guard,
    });
    const h = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: ONE_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const final = await h.awaitTerminal();
    expect(final.status).toBe('failed');
    expect(final.lastError).toMatch(/workspace_cap_exhausted/);
    expect(spawned).toBe(0);

    const stages = repo.listStagesForRun(final.id);
    expect(stages).toHaveLength(1);
    expect(stages[0].status).toBe('failed');
    expect(stages[0].lastError).toMatch(/budget_guard_denied/);
  });

  it('passes context (runId, stageId, agent, costs) to the guard', async () => {
    const { repo } = setup();
    const observed: BudgetGuardContext[] = [];
    const guard: BudgetGuard = {
      check: (ctx) => {
        observed.push(ctx);
        return { allow: true };
      },
    };
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult({ costUsd: 0.4 }) },
      codex: { terminal: makeResult({ costUsd: 0.1 }) },
    });
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
      budgetGuard: guard,
    });
    const h = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: TWO_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    await h.awaitTerminal();
    expect(observed).toHaveLength(2);
    expect(observed[0].stageId).toBe('fix');
    expect(observed[0].agent).toBe('claude');
    expect(observed[0].stageMaxBudgetUsd).toBe(2);
    expect(observed[0].runTotalCostUsd).toBe(0);
    expect(observed[1].stageId).toBe('review');
    expect(observed[1].agent).toBe('codex');
    expect(observed[1].stageMaxBudgetUsd).toBe(1);
    // After fix completed at $0.40, stage 2 sees the accumulated total.
    expect(observed[1].runTotalCostUsd).toBe(0.4);
  });

  it('async guard resolves before spawn proceeds', async () => {
    const { repo } = setup();
    const order: string[] = [];
    const guard: BudgetGuard = {
      check: async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push('guard');
        return { allow: true };
      },
    };
    const factory = buildAdapterFactory({
      claude: {
        onSpawn: () => {
          order.push('spawn');
        },
        terminal: makeResult(),
      },
    });
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
      budgetGuard: guard,
    });
    const h = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: ONE_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    await h.awaitTerminal();
    expect(order).toEqual(['guard', 'spawn']);
  });
});
