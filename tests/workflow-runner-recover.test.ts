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

describe('WorkflowRunner — T6 recoverStaleRuns', () => {
  it('marks orphaned active runs + their non-terminal stages as failed', async () => {
    const { db, repo } = setup();
    // Simulate a prior process that crashed mid-stage: a `running`
    // run with one `done` stage and one `running` stage.
    const factory = buildAdapterFactory({ claude: { terminal: makeResult() } });
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    // Seed the orphan directly via repo (not via runner.start) so the
    // dispatch loop never claims it.
    const { run } = repo.createRun({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      graphSnapshot: ONE_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      initialStatus: 'running',
    });
    const stage = repo.createStage({
      runId: run.id,
      stageIdInGraph: 'fix',
      stageKind: 'cli_agent',
      agentName: 'claude',
      initialStatus: 'running',
    });
    // Drop active_pid like a crashed sidecar would have left.
    db.prepare(`UPDATE workflow_run_stages SET active_pid = ? WHERE id = ?`).run(
      99999,
      stage.id,
    );

    const { recoveredRunIds } = runner.recoverStaleRuns();
    expect(recoveredRunIds).toEqual([run.id]);

    const after = repo.getRun(run.id)!;
    expect(after.status).toBe('failed');
    expect(after.lastError).toBe('interrupted_by_restart');
    expect(after.currentStageId).toBeNull();
    expect(after.finishedAt).toBeTruthy();

    const recoveredStage = repo.getStage(stage.id)!;
    expect(recoveredStage.status).toBe('failed');
    expect(recoveredStage.lastError).toBe('interrupted_by_restart');
    expect(recoveredStage.activePid).toBeNull();
  });

  it('skips runs owned by an in-process dispatch loop', async () => {
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
    // Run is in flight; sweep should NOT touch it.
    await new Promise((r) => setTimeout(r, 20));
    const { recoveredRunIds } = runner.recoverStaleRuns();
    expect(recoveredRunIds).toEqual([]);

    const final = await handle.awaitTerminal();
    expect(final.status).toBe('done');
  });

  it('returns empty list when there are no orphans', () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({ claude: { terminal: makeResult() } });
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const result = runner.recoverStaleRuns();
    expect(result.recoveredRunIds).toEqual([]);
  });

  it('is idempotent — second call is a no-op after the first', () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({ claude: { terminal: makeResult() } });
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    repo.createRun({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      graphSnapshot: ONE_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      initialStatus: 'running',
    });
    const first = runner.recoverStaleRuns();
    expect(first.recoveredRunIds).toHaveLength(1);
    const second = runner.recoverStaleRuns();
    expect(second.recoveredRunIds).toEqual([]);
  });
});
