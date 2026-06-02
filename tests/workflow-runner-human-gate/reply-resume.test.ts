import { describe, expect, it } from 'vitest';

import {
  WorkflowRunner,
  type HumanGateHandler,
} from '../../src/core/auto-code/workflows/runner.js';
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
 * Phase 5 MVP Human-in-Loop — userReply resume + idempotency.
 *
 *  - Resume re-enters dispatch from the outbound edge with the user
 *    reply threaded through stageOutputs + reopenContext.
 *  - Resume is idempotent — double-fire from a noisy chat-route
 *    retry collapses to one dispatch.
 */

describe('Phase 5 MVP — Human-in-Loop reply / resume', () => {
  it('resumeFromHumanGate flips status back to running, threads userReply through, run reaches complete_sink', async () => {
    const { db, repo } = setupHumanGateCtx();
    insertStubSession(db, 'sess-xyz');
    const handler: HumanGateHandler = async () => ({ ok: true, sessionId: 'sess-xyz' });
    const userReplyCaptured: Array<string | undefined> = [];
    const moDispatcher = stubMoDispatcher((stageId, input) => {
      if (stageId === 'mo_start') return { ok: true, branch: 'accept', reason: '', costUsd: 0 };
      if (stageId === 'mo_after_fix') {
        // First pass before pause: pick ask_human.
        // Second pass after resume: pick review (user answered).
        const reply = (input.reopenContext as { userReply?: string }).userReply;
        userReplyCaptured.push(reply);
        if (reply) {
          return { ok: true, branch: 'review', reason: `picked based on user: ${reply}`, costUsd: 0 };
        }
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
    const startHandle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: workflowWithHumanGate(),
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: { id: TICKET_ID, title: 'Add eyes', body: '' },
    });
    // Wait for pause.
    let row = repo.getRun(startHandle.runId);
    for (let i = 0; i < 50 && row?.status !== 'paused_ask_user'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      row = repo.getRun(startHandle.runId);
    }
    expect(row?.status).toBe('paused_ask_user');

    // Resume with user reply.
    const resumeHandle = runner.resumeFromHumanGate({
      runId: startHandle.runId,
      userReply: 'blink slowly please',
      ticketContext: { id: TICKET_ID, title: 'Add eyes', body: '' },
    });
    const final = await resumeHandle.awaitTerminal();
    expect(final.status).toBe('done');
    expect(final.lastError).toBeNull();
    // Mo's second pass received the user reply via reopenContext.
    expect(userReplyCaptured).toContain('blink slowly please');
    // pausedSessionId cleared after resume.
    expect(final.pausedSessionId).toBeNull();
    expect(final.pausedAt).toBeNull();
  });

  it('resume is idempotent — second call on already-resumed run is a no-op', async () => {
    const { db, repo } = setupHumanGateCtx();
    insertStubSession(db, 'sess-xyz');
    const handler: HumanGateHandler = async () => ({ ok: true, sessionId: 'sess-xyz' });
    const moDispatcher = stubMoDispatcher((stageId, input) => {
      if (stageId === 'mo_start') return { ok: true, branch: 'accept', reason: '', costUsd: 0 };
      if (stageId === 'mo_after_fix') {
        const reply = (input.reopenContext as { userReply?: string }).userReply;
        if (reply) {
          return { ok: true, branch: 'review', reason: '', costUsd: 0 };
        }
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
    const startHandle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: workflowWithHumanGate(),
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: { id: TICKET_ID, title: 'Add eyes', body: '' },
    });
    let row = repo.getRun(startHandle.runId);
    for (let i = 0; i < 50 && row?.status !== 'paused_ask_user'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      row = repo.getRun(startHandle.runId);
    }
    const firstResume = runner.resumeFromHumanGate({
      runId: startHandle.runId,
      userReply: 'slowly',
      ticketContext: { id: TICKET_ID, title: 'Add eyes', body: '' },
    });
    await firstResume.awaitTerminal();
    // Second resume after terminal — should return a deduped handle
    // that doesn't crash + doesn't re-enter dispatch.
    const secondResume = runner.resumeFromHumanGate({
      runId: startHandle.runId,
      userReply: 'whatever',
      ticketContext: { id: TICKET_ID, title: 'Add eyes', body: '' },
    });
    const final2 = await secondResume.awaitTerminal();
    expect(final2.status).toBe('done');
  });
});
