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

describe('WorkflowRunner — failure paths', () => {
  it('marks run failed when an adapter emits ErrorEvent', async () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({
      claude: { terminal: makeError({ errorKind: 'codex_ink_crash', message: 'Ink failed' }) },
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
    const finalRun = await handle.awaitTerminal();
    expect(finalRun.status).toBe('failed');
    expect(finalRun.lastError).toMatch(/codex_ink_crash/);

    const stages = repo.listStagesForRun(finalRun.id);
    expect(stages).toHaveLength(1);
    expect(stages[0].status).toBe('failed');
  });

  it('does not run subsequent stages after a stage fails', async () => {
    const { repo } = setup();
    let codexSpawned = false;
    const factory = buildAdapterFactory({
      claude: { terminal: makeError({ errorKind: 'spawn_failed', message: 'oops' }) },
      codex: {
        onSpawn: () => {
          codexSpawned = true;
        },
        terminal: makeResult(),
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
    expect(codexSpawned).toBe(false);
  });

  it('marks run failed when adapter.spawn throws', async () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({
      claude: {
        throwOnSpawn: new Error('AgentSpawnError: ENOENT'),
        terminal: makeResult(),
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
    const finalRun = await handle.awaitTerminal();
    expect(finalRun.status).toBe('failed');
    expect(finalRun.lastError).toMatch(/ENOENT/);
  });
});

describe('WorkflowRunner — cancel', () => {
  it('marks run cancelled when killed mid-stage', async () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult({ costUsd: 0.5 }), terminalDelay: 200 },
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
    // Give the dispatch loop a beat to spawn the adapter.
    await new Promise((r) => setTimeout(r, 30));
    await handle.cancel('user_toggle_off');
    const finalRun = await handle.awaitTerminal();
    expect(finalRun.status).toBe('cancelled');
    expect(finalRun.cancelRequested).toBe(true);
  });

  it('cancel is idempotent', async () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult(), terminalDelay: 100 },
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
    await new Promise((r) => setTimeout(r, 20));
    await handle.cancel();
    await handle.cancel();
    await handle.cancel();
    const finalRun = await handle.awaitTerminal();
    expect(finalRun.status).toBe('cancelled');
  });
});
