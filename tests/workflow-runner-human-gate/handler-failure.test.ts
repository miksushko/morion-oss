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
  setupHumanGateCtx,
  stubMoDispatcher,
  workflowWithHumanGate,
} from '../helpers/workflow-runner-human-gate-setup.js';

/**
 * Phase 5 MVP Human-in-Loop — handler-failure path.
 *
 * When the humanGateHandler returns `{ok: false, reason}` the runner
 * must terminate cleanly with `human_gate_handler_failed: <reason>`
 * — no half-paused state, no leaked sessions.
 */

describe('Phase 5 MVP — Human-in-Loop handler failure', () => {
  it('handler failure → run terminates with human_gate_handler_failed', async () => {
    const { repo } = setupHumanGateCtx();
    const handler: HumanGateHandler = async () => ({
      ok: false,
      reason: 'concierge_not_wired',
    });
    const moDispatcher = stubMoDispatcher((stageId) => {
      if (stageId === 'mo_start') return { ok: true, branch: 'accept', reason: '', costUsd: 0 };
      if (stageId === 'mo_after_fix')
        return { ok: true, branch: 'ask_human', reason: '', costUsd: 0 };
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
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('failed');
    expect(final.lastError).toContain('human_gate_handler_failed');
    expect(final.lastError).toContain('concierge_not_wired');
  });
});
