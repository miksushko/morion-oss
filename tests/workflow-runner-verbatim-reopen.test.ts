import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { openDb } from '../src/core/db/client.js';
import { WorkflowRunsRepository } from '../src/core/auto-code/workflows/runs-repository.js';
import { WorkflowRunner } from '../src/core/auto-code/workflows/runner.js';
import { parseDraftWorkflow } from '../src/core/auto-code/workflows/parse-linear.js';
import type {
  CliAgentName,
  WorkflowDefinition,
} from '../src/core/auto-code/workflows/types/index.js';
import type {
  MoStageDispatcher,
  MoStageDispatchResult,
} from '../src/core/auto-code/workflows/mo-stage-dispatcher.js';
import type {
  AgentHandle,
  CliAgentAdapter,
  SpawnOptions,
} from '../src/core/auto-code/harness/adapter.js';
import type {
  CliAgentEvent,
  ResultEvent,
} from '../src/core/auto-code/harness/events.js';

/**
 * Verbatim reopen — "Mo = router, not narrator" epic.
 *
 * On a DAG loop-back the reopened agent must receive the deciding
 * source stage's OWN full output (the reviewer's verdict, verbatim,
 * banner-wrapped) — not just Mo's one-line routing rationale. Parity
 * with the legacy linear path's formatReopenReason behaviour.
 */

const FOLDER_ID = 'fld_vr';
const TICKET_ID = 'note_vr';
const TRANSCRIPT_DIR = '/tmp/morion-vr-transcripts';

const REVIEWER_VERDICT = [
  'The fix is on the right track but incomplete.',
  '1. `rotatePiece()` in src/game.js still mutates the shared matrix — clone before rotating.',
  '2. The wall-kick table misses the I-piece special case (SRS spec section 5.3).',
  '3. No regression test covers rotation at the left wall.',
  'Reopen and address all three points before the next review pass.',
].join('\n');

function setup(): { db: Database.Database; repo: WorkflowRunsRepository } {
  const handle = openDb({ path: ':memory:' });
  handle.db
    .prepare(`INSERT INTO folders (id, name, position, created_at) VALUES (?, ?, 0, ?)`)
    .run(FOLDER_ID, 'Test', Date.now());
  handle.db
    .prepare(
      `INSERT INTO notes (id, folder_id, title, body, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'user', ?, ?)`,
    )
    .run(TICKET_ID, FOLDER_ID, 'Tetris', 'Build tetris', Date.now(), Date.now());
  return { db: handle.db, repo: new WorkflowRunsRepository(handle.db) };
}

function makeResult(overrides: Partial<ResultEvent> = {}): ResultEvent {
  return {
    kind: 'result',
    exitCode: 0,
    summary: 'done',
    costUsd: 0,
    terminalReason: 'completed',
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Mock adapter that logs EVERY spawn's options (the DAG test's
 *  MockAdapter keeps only the last — reopen needs both). */
class LoggingAdapter implements CliAgentAdapter {
  public spawns: SpawnOptions[] = [];
  constructor(
    public readonly name: CliAgentName,
    private readonly summaries: string[],
  ) {}
  async spawn(opts: SpawnOptions): Promise<AgentHandle> {
    const idx = this.spawns.length;
    this.spawns.push(opts);
    const terminal = makeResult({
      summary: this.summaries[Math.min(idx, this.summaries.length - 1)],
    });
    const sessionId = `mock-${this.name}-${idx}`;
    let resolveExited!: () => void;
    const exited = new Promise<void>((r) => (resolveExited = r));
    async function* stream(): AsyncIterable<CliAgentEvent> {
      try {
        yield {
          kind: 'session_start',
          sessionId,
          agent: 'claude',
          timestamp: Date.now(),
        } as CliAgentEvent;
        yield terminal;
      } finally {
        resolveExited();
      }
    }
    return {
      adapter: this.name,
      sessionId,
      pid: 1,
      exited,
      events: stream(),
      cancel: async () => {},
      resume: async () => {
        throw new Error('not implemented');
      },
      getCost: () => 0,
    };
  }
}

function workflow(): WorkflowDefinition {
  return parseDraftWorkflow({
    schemaVersion: 1,
    name: 'reopen-verbatim',
    stages: [
      {
        id: 'start',
        kind: 'mo_stage',
        isStart: true,
        instruction: 'gate',
        branches: ['accept', 'reject'],
        postComment: true,
        allowedTools: [],
      },
      {
        id: 'fix',
        kind: 'cli_agent',
        agent: 'claude',
        promptTemplate: 'fix {{ticket.title}}\n\n{{reopen.reason}}',
        maxBudgetUsd: 1,
        maxAttempts: 3,
        allowedTools: [],
      },
      {
        id: 'mo_after_fix',
        kind: 'mo_stage',
        instruction: 'route',
        branches: ['review', 'reject'],
        postComment: true,
        allowedTools: [],
      },
      {
        id: 'review',
        kind: 'cli_agent',
        agent: 'codex',
        promptTemplate: 'review {{stages.fix.output.summary}}',
        maxBudgetUsd: 1,
        maxAttempts: 3,
        allowedTools: [],
      },
      {
        id: 'mo_after_review',
        kind: 'mo_stage',
        instruction: 'verdict',
        branches: ['approve', 'reopen', 'reject'],
        postComment: true,
        allowedTools: [],
      },
      { id: 'reject_t', kind: 'reject_sink', commentTemplate: '' },
      { id: 'complete_t', kind: 'complete_sink', commentTemplate: '' },
    ],
    edges: [
      { from: 'start', to: 'fix', on: 'accept' },
      { from: 'start', to: 'reject_t', on: 'reject' },
      { from: 'fix', to: 'mo_after_fix', on: 'success' },
      { from: 'mo_after_fix', to: 'review', on: 'review' },
      { from: 'mo_after_fix', to: 'reject_t', on: 'reject' },
      { from: 'review', to: 'mo_after_review', on: 'success' },
      { from: 'mo_after_review', to: 'complete_t', on: 'approve' },
      { from: 'mo_after_review', to: 'fix', on: 'reopen' },
      { from: 'mo_after_review', to: 'reject_t', on: 'reject' },
    ],
  });
}

describe('WorkflowRunner — verbatim reopen', () => {
  it('reopened fixer receives the reviewer verdict verbatim + Mo rationale, then context clears', async () => {
    const { repo } = setup();
    const fixer = new LoggingAdapter('claude', ['first fix attempt', 'second fix attempt']);
    const reviewer = new LoggingAdapter('codex', [REVIEWER_VERDICT, 'all points addressed, ship it']);

    let afterReviewCalls = 0;
    const moDispatcher: MoStageDispatcher = {
      async decide(input): Promise<MoStageDispatchResult> {
        if (input.stage.id === 'start') {
          return { ok: true, branch: 'accept', reason: 'ticket ok', costUsd: 0 };
        }
        if (input.stage.id === 'mo_after_fix') {
          return { ok: true, branch: 'review', reason: 'diff produced', costUsd: 0 };
        }
        afterReviewCalls++;
        return afterReviewCalls === 1
          ? { ok: true, branch: 'reopen', reason: 'reviewer requested another pass', costUsd: 0 }
          : { ok: true, branch: 'approve', reason: 'reviewer signed off', costUsd: 0 };
      },
    };

    const runner = new WorkflowRunner({
      repo,
      adapterFactory: (a) => (a === 'claude' ? fixer : reviewer),
      transcriptDir: TRANSCRIPT_DIR,
      moStageDispatcher: moDispatcher,
    });
    const handle = await runner.start({
      definition: workflow(),
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      ticketContext: { id: TICKET_ID, title: 'Tetris', body: 'tetris' },
      worktreePath: '/tmp/morion-vr-repo/.morion/worktrees/auto-x',
      repoPath: '/tmp/morion-vr-repo',
    });
    const row = await handle.awaitTerminal();
    expect(row.status).toBe('done');
    expect(row.lastError).toBeNull();

    // Two fix spawns: initial + reopened.
    expect(fixer.spawns.length).toBe(2);
    const firstPrompt = fixer.spawns[0].prompt;
    const reopenedPrompt = fixer.spawns[1].prompt;

    // Initial spawn: no reopen context.
    expect(firstPrompt).not.toContain('Previous reviewer feedback');
    expect(firstPrompt).not.toContain(REVIEWER_VERDICT);

    // Reopened spawn: the FULL reviewer verdict, verbatim, banner-
    // wrapped with the source stage named — plus Mo's rationale as a
    // separate labelled line that supplements, never replaces.
    expect(reopenedPrompt).toContain(REVIEWER_VERDICT);
    expect(reopenedPrompt).toContain('--- Previous reviewer feedback (from "review" stage) ---');
    expect(reopenedPrompt).toContain('Mo routing rationale: reviewer requested another pass');

    // Second review pass sees the second fix attempt's own words.
    expect(reviewer.spawns.length).toBe(2);
    expect(reviewer.spawns[1].prompt).toContain('second fix attempt');
  });
});
