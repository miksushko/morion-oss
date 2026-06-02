import { describe, expect, it } from 'vitest';

import {
  WorkflowRunner,
  type HumanGateHandler,
} from '../../src/core/auto-code/workflows/runner.js';
import { parseRunnableWorkflow } from '../../src/core/auto-code/workflows/parse-linear.js';
import {
  FOLDER_ID,
  MockAdapter,
  REPO_PATH,
  TICKET_ID,
  TRANSCRIPT_DIR,
  WORKTREE_PATH,
  insertStubSession,
  setupHumanGateCtx,
  stubMoDispatcher,
  workflowWithHumanGate,
} from '../helpers/workflow-runner-human-gate-setup.js';

/**
 * Phase 5 MVP Human-in-Loop — gate emit + repo-level atomicity.
 *
 *  1. parseRunnableWorkflow accepts a DAG containing `human_gate`
 *     (vs throwing LinearWorkflowError as Phase 4 did).
 *  2. Runner pauses on `human_gate` — workflow_runs.status flips to
 *     `paused_ask_user`, paused_session_id is stamped, dispatch exits
 *     without calling terminate.
 *  3. Repo-level pauseForHumanGate is atomic against concurrent cancel.
 *  4. Repo-level resumeFromHumanGate refuses non-paused rows.
 */

describe('Phase 5 MVP — Human-in-Loop emit', () => {
  it('parser whitelist: parseRunnableWorkflow accepts a DAG containing human_gate', () => {
    const def = workflowWithHumanGate();
    // Before Phase 5 this threw LinearWorkflowError.
    expect(() => parseRunnableWorkflow(def)).not.toThrow();
  });

  it('runner pauses on human_gate — status flips to paused_ask_user, session linked, dispatch exits cleanly', async () => {
    const { db, repo } = setupHumanGateCtx();
    const handlerCalls: Array<{ runId: string; guidance: string | undefined }> = [];
    insertStubSession(db, 'sess-xyz');
    const handler: HumanGateHandler = async (args) => {
      handlerCalls.push({ runId: args.runId, guidance: args.guidance });
      return { ok: true, sessionId: 'sess-xyz' };
    };
    let moPick = 0;
    const moDispatcher = stubMoDispatcher((stageId) => {
      if (stageId === 'mo_start') return { ok: true, branch: 'accept', reason: '', costUsd: 0 };
      if (stageId === 'mo_after_fix') {
        moPick++;
        return { ok: true, branch: 'ask_human', reason: '', costUsd: 0 };
      }
      throw new Error(`unexpected stage ${stageId}`);
    });
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: () => new MockAdapter('claude'),
      transcriptDir: TRANSCRIPT_DIR,
      moStageDispatcher: moDispatcher,
      humanGateHandler: handler,
    });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: workflowWithHumanGate(),
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: { id: TICKET_ID, title: 'Add eyes', body: '' },
    });
    // Without resume, the run sits paused indefinitely. Don't await
    // terminal — wait for status flip by polling the row briefly.
    let row = repo.getRun(handle.runId);
    for (let i = 0; i < 50 && row?.status !== 'paused_ask_user'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      row = repo.getRun(handle.runId);
    }
    expect(row?.status).toBe('paused_ask_user');
    expect(row?.pausedSessionId).toBe('sess-xyz');
    expect(row?.pausedAt).toBeGreaterThan(0);
    expect(row?.currentStageId).toBe('gate9');
    expect(handlerCalls).toHaveLength(1);
    expect(handlerCalls[0]?.guidance).toBe('Should the eyes blink slowly or quickly?');
    expect(moPick).toBe(1);
  });

  it('repo pauseForHumanGate is atomic — concurrent cancel wins cleanly', () => {
    const { db, repo } = setupHumanGateCtx();
    insertStubSession(db, 'sess-late');
    const { run } = repo.createRun({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      graphSnapshot: workflowWithHumanGate(),
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      initialStatus: 'running',
    });
    // Simulate cancel arriving before pause.
    repo.updateRun(run.id, { cancelRequested: true });
    const flipped = repo.pauseForHumanGate(
      { runId: run.id, sessionId: 'sess-late', humanGateStageId: 'gate9' },
      Date.now(),
    );
    expect(flipped).toBe(false);
    const fresh = repo.getRun(run.id);
    expect(fresh?.status).toBe('running'); // unchanged
    expect(fresh?.pausedSessionId).toBeNull();
  });

  it('repo resumeFromHumanGate refuses non-paused rows', () => {
    const { repo } = setupHumanGateCtx();
    const { run } = repo.createRun({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      graphSnapshot: workflowWithHumanGate(),
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      initialStatus: 'running',
    });
    const r = repo.resumeFromHumanGate(run.id);
    expect(r).toBeNull(); // wasn't paused
  });
});
