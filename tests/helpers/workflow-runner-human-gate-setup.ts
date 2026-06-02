import type Database from 'better-sqlite3';

import { openDb } from '../../src/core/db/client.js';
import { WorkflowRunsRepository } from '../../src/core/auto-code/workflows/runs-repository.js';
import { parseDraftWorkflow } from '../../src/core/auto-code/workflows/parse-linear.js';
import type {
  CliAgentName,
  WorkflowDefinition,
} from '../../src/core/auto-code/workflows/types/index.js';
import type {
  MoStageDispatcher,
  MoStageDispatchResult,
} from '../../src/core/auto-code/workflows/mo-stage-dispatcher.js';
import type {
  AgentHandle,
  CliAgentAdapter,
  SpawnOptions,
} from '../../src/core/auto-code/harness/adapter.js';
import type {
  CliAgentEvent,
  ResultEvent,
} from '../../src/core/auto-code/harness/events.js';

/**
 * Shared fixtures for `tests/workflow-runner-human-gate/*` — Phase 5
 * MVP Human-in-Loop runtime tests. Provides DB context, stub session
 * inserter (FK satisfier for workflow_runs.paused_session_id), a
 * minimal MockAdapter that emits one session_start + one terminal
 * result, a programmable MoStageDispatcher stub, and the canonical
 * "human_gate-after-fix" workflow definition.
 */

export const FOLDER_ID = 'fld_hg';
export const TICKET_ID = 'note_hg';
export const REPO_PATH = '/tmp/morion-hg-repo';
export const WORKTREE_PATH = '/tmp/morion-hg-repo/.morion/worktrees/auto-x';
export const TRANSCRIPT_DIR = '/tmp/morion-hg-transcripts';

export interface HumanGateCtx {
  db: Database.Database;
  repo: WorkflowRunsRepository;
}

export function setupHumanGateCtx(): HumanGateCtx {
  const handle = openDb({ path: ':memory:' });
  handle.db
    .prepare(`INSERT INTO folders (id, name, position, created_at) VALUES (?, ?, 0, ?)`)
    .run(FOLDER_ID, 'Test', Date.now());
  handle.db
    .prepare(
      `INSERT INTO notes (id, folder_id, title, body, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'user', ?, ?)`,
    )
    .run(TICKET_ID, FOLDER_ID, 'Add eyes', 'Add eyes to pieces', Date.now(), Date.now());
  return { db: handle.db, repo: new WorkflowRunsRepository(handle.db) };
}

/** Insert a stub concierge_sessions row so the FK on
 *  workflow_runs.paused_session_id passes when the test's
 *  humanGateHandler returns the corresponding id. Production handler
 *  creates a real row via ConciergeSessionsRepository; tests shortcut
 *  with raw INSERT to avoid the full sessions repo setup. */
export function insertStubSession(
  db: Database.Database,
  sessionId: string,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO concierge_sessions (
       id, folder_id, title, opened_by, needs_human, archived_at,
       workflow_run_id, created_at, updated_at
     ) VALUES (?, NULL, '', 'concierge', 1, NULL, NULL, ?, ?)`,
  ).run(sessionId, now, now);
}

export function makeResult(overrides: Partial<ResultEvent> = {}): ResultEvent {
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

export class MockAdapter implements CliAgentAdapter {
  public lastOpts: SpawnOptions | null = null;
  constructor(public readonly name: CliAgentName) {}
  async spawn(opts: SpawnOptions): Promise<AgentHandle> {
    this.lastOpts = opts;
    const sessionId = `mock-${Math.random().toString(36).slice(2)}`;
    const terminal = makeResult({ summary: 'agent produced a fix', costUsd: 0.2 });
    let resolveExited!: () => void;
    const exited = new Promise<void>((r) => (resolveExited = r));
    async function* stream(): AsyncIterable<CliAgentEvent> {
      try {
        yield { kind: 'session_start', sessionId, agent: 'claude', timestamp: Date.now() };
        yield terminal;
      } finally {
        resolveExited();
      }
    }
    return {
      adapter: 'claude',
      sessionId,
      pid: 1,
      exited,
      events: stream(),
      cancel: async () => {},
      resume: async () => {
        throw new Error('not implemented');
      },
      getCost: () => terminal.costUsd,
    };
  }
}

export function stubMoDispatcher(
  pick: (
    stageId: string,
    input: { reopenContext: Record<string, unknown> },
  ) => MoStageDispatchResult,
): MoStageDispatcher {
  return {
    async decide(input) {
      return pick(input.stage.id, { reopenContext: input.reopenContext });
    },
  };
}

/** Workflow with a `human_gate` after the fix:
 *
 *   mo_start ──accept──▶ fix ──success──▶ mo_after_fix
 *                                              ├──ask_human──▶ human_gate ── ▶ mo_after_fix
 *                                              ├──review──▶ complete_t
 *                                              └──reject──▶ reject_t
 */
export function workflowWithHumanGate(): WorkflowDefinition {
  return parseDraftWorkflow({
    schemaVersion: 1,
    name: 'human-gate-test',
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
        maxAttempts: 1,
        allowedTools: [],
      },
      {
        id: 'mo_after_fix',
        kind: 'mo_stage',
        instruction: 'decide',
        branches: ['ask_human', 'review', 'reject'],
        postComment: false,
        allowedTools: [],
      },
      {
        id: 'gate9',
        kind: 'human_gate',
        guidance: 'Should the eyes blink slowly or quickly?',
      },
      {
        id: 'complete_t',
        kind: 'complete_sink',
        commentTemplate: 'Done!',
      },
      {
        id: 'reject_t',
        kind: 'reject_sink',
        commentTemplate: 'Rejected.',
      },
    ],
    edges: [
      { from: 'mo_start', to: 'fix', on: 'accept' },
      { from: 'mo_start', to: 'reject_t', on: 'reject' },
      { from: 'fix', to: 'mo_after_fix', on: 'success' },
      { from: 'mo_after_fix', to: 'gate9', on: 'ask_human' },
      { from: 'mo_after_fix', to: 'complete_t', on: 'review' },
      { from: 'mo_after_fix', to: 'reject_t', on: 'reject' },
      { from: 'gate9', to: 'mo_after_fix', on: '' },
    ],
  });
}
