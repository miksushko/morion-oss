import { describe, expect, it } from 'vitest';

import {
  WorkflowRunner,
  type HumanGateHandler,
} from '../../src/core/auto-code/workflows/runner.js';
import { parseDraftWorkflow } from '../../src/core/auto-code/workflows/parse-linear.js';
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
} from '../helpers/workflow-runner-human-gate-setup.js';

/**
 * Phase 5 MVP Human-in-Loop — cli_agent re-execution loop.
 *
 * CLAUDE.md-pinned regression for ticket 01KRMA2WWK65K42MD3Q34GE5YJ
 * (workflow runner: stale userReply re-injected on every re-open
 * after human_gate → infinite mo_after_fix loop). Production bug
 * came from run 01KRM96BD0A2B5D8JRJ16CWFAY:
 *
 *   1. cli_agent #1 done
 *   2. mo_after_fix picks ask_human
 *   3. human_gate captures user reply "REPLY-ONE"
 *   4. mo_after_fix #2 sees userReply=REPLY-ONE, picks re-open
 *      (loop back into the cli_agent stage)
 *   5. cli_agent #2 done
 *   6. mo_after_fix #3 — BEFORE FIX: still saw userReply=REPLY-ONE
 *      and the dispatcher's "user just answered" signal lied.
 *      AFTER FIX: userReply is undefined (consumed at step 4).
 *
 * Asserts the dispatcher's `reopenContext.userReply` at call #3 is
 * empty / undefined — Mo no longer gets a stale "fresh user reply"
 * marker on subsequent loop iterations.
 *
 * The clear lives in stage-mo-decision.ts (after fold-into-reopenContext)
 * and dispatch-dag.ts (after cli_agent advance). State.reopenContext
 * must be cleared after cli_agent re-execution — pinned regression.
 */

describe('Phase 5 MVP — Human-in-Loop cli_agent re-execution loop', () => {
  it('regression 01KRMA2WWK65K42MD3Q34GE5YJ — userReply consumed after first re-open, not re-fed on subsequent loop-backs', async () => {
    // Workflow with a re-open edge: mo_after_fix → cli_agent fix.
    // Mirrors the v2 default-autocode shape and reproduces the
    // production bug's graph topology.
    const def = parseDraftWorkflow({
      schemaVersion: 1,
      name: 'reopen-loop-regression',
      stages: [
        {
          id: 'mo_start',
          kind: 'mo_stage',
          isStart: true,
          instruction: 'gate',
          branches: ['accept', 'reject'],
          postComment: false,
          allowedTools: [],
        },
        {
          id: 'fix',
          kind: 'cli_agent',
          agent: 'claude',
          promptTemplate: 'fix {{ticket.title}}',
          maxBudgetUsd: 1,
          maxAttempts: 5,
          allowedTools: [],
        },
        {
          id: 'mo_after_fix',
          kind: 'mo_stage',
          instruction: 'decide',
          branches: ['ask_human', 're-open', 'review', 'reject'],
          postComment: false,
          allowedTools: [],
        },
        { id: 'gate', kind: 'human_gate', guidance: 'clarify' },
        { id: 'complete_t', kind: 'complete_sink', commentTemplate: 'done' },
        { id: 'reject_t', kind: 'reject_sink', commentTemplate: 'rejected' },
      ],
      edges: [
        { from: 'mo_start', to: 'fix', on: 'accept' },
        { from: 'mo_start', to: 'reject_t', on: 'reject' },
        { from: 'fix', to: 'mo_after_fix', on: 'success' },
        { from: 'mo_after_fix', to: 'gate', on: 'ask_human' },
        { from: 'mo_after_fix', to: 'fix', on: 're-open' },
        { from: 'mo_after_fix', to: 'complete_t', on: 'review' },
        { from: 'mo_after_fix', to: 'reject_t', on: 'reject' },
        { from: 'gate', to: 'mo_after_fix', on: '' },
      ],
    });

    const { db, repo } = setupHumanGateCtx();
    insertStubSession(db, 'sess-loop');
    const handler: HumanGateHandler = async () => ({ ok: true, sessionId: 'sess-loop' });

    // Capture what userReply each mo_after_fix dispatch saw.
    const moAfterFixCalls: Array<{ call: number; userReply: string | undefined }> = [];
    let callCount = 0;
    const moDispatcher = stubMoDispatcher((stageId, input) => {
      if (stageId === 'mo_start') {
        return { ok: true, branch: 'accept', reason: '', costUsd: 0 };
      }
      if (stageId === 'mo_after_fix') {
        callCount++;
        const reply = (input.reopenContext as { userReply?: string }).userReply;
        moAfterFixCalls.push({ call: callCount, userReply: reply });
        // Call 1: no reply yet → ask_human.
        // Call 2: reply present → re-open (loop back).
        // Call 3: should NOT see stale reply → pick review to end the
        //   loop cleanly. If the bug regressed, Mo would still see
        //   the reply; the assertion below catches that.
        if (callCount === 1) {
          return { ok: true, branch: 'ask_human', reason: '', costUsd: 0 };
        }
        if (callCount === 2) {
          return { ok: true, branch: 're-open', reason: 'user replied', costUsd: 0 };
        }
        return { ok: true, branch: 'review', reason: 'done', costUsd: 0 };
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
      definition: def,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: { id: TICKET_ID, title: 'fix the bug', body: '' },
    });

    // Wait for the run to pause on human_gate.
    let row = repo.getRun(startHandle.runId);
    for (let i = 0; i < 50 && row?.status !== 'paused_ask_user'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      row = repo.getRun(startHandle.runId);
    }
    expect(row?.status).toBe('paused_ask_user');

    // Resume with the user's reply. The runner will re-enter
    // mo_after_fix, which decides re-open → fix → mo_after_fix again.
    const resumeHandle = runner.resumeFromHumanGate({
      runId: startHandle.runId,
      userReply: 'REPLY-ONE',
      ticketContext: { id: TICKET_ID, title: 'fix the bug', body: '' },
    });
    const final = await resumeHandle.awaitTerminal();
    expect(final.status).toBe('done');

    // mo_after_fix fired exactly 3 times in this scenario.
    expect(moAfterFixCalls.length).toBe(3);
    // Call 1: no reply yet (pre-human_gate).
    expect(moAfterFixCalls[0]!.userReply).toBeUndefined();
    // Call 2: reply present (right after gate). Folded from gate.output.
    expect(moAfterFixCalls[1]!.userReply).toBe('REPLY-ONE');
    // Call 3: reply consumed at call 2 → must be empty / undefined.
    // This is the load-bearing assertion: without the fix, call 3
    // would still see 'REPLY-ONE' and the dispatcher would re-loop.
    expect(
      moAfterFixCalls[2]!.userReply === undefined ||
        moAfterFixCalls[2]!.userReply === '',
    ).toBe(true);
  });
});
