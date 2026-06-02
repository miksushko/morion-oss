/**
 * Shared fixtures + mock adapter for the WorkflowRunner test suite.
 *
 * The 1896-LOC `tests/workflow-runner.test.ts` god-file is split into
 * scenario-focused suites (`tests/workflow-runner-<scenario>.test.ts`)
 * that all import from here. Vitest's `include` pattern is
 * `tests/**\/*.test.ts`, so this file is not collected as a test.
 *
 * The MockAdapter is deliberate. Real adapters spawn child processes and
 * stream events from real Claude / Codex / Pi binaries — that's covered
 * by the per-adapter integration tests (`claude-adapter.test.ts`,
 * `codex-adapter.test.ts`, etc.). The runner test suite only needs to
 * verify the runner's behavior given known adapter outputs: stage
 * ordering, prompt rendering, budget pre-flight, verdict-policy loop,
 * hooks, persistence, recovery. So we wire a synchronous mock that
 * emits canned events and lets each scenario describe the agent
 * behavior in one struct (`MockBehavior`).
 */
import type Database from 'better-sqlite3';

import { openDb } from '../../src/core/db/client.js';
import { WorkflowRunsRepository } from '../../src/core/auto-code/workflows/runs-repository.js';
import {
  type CliAgentName,
  type WorkflowDefinition,
} from '../../src/core/auto-code/workflows/types/index.js';
import { parseLinearWorkflow } from '../../src/core/auto-code/workflows/parse-linear.js';
import type {
  AgentHandle,
  CliAgentAdapter,
  SpawnOptions,
} from '../../src/core/auto-code/harness/adapter.js';
import type {
  AgentName,
  CliAgentEvent,
  ErrorEvent,
  ResultEvent,
} from '../../src/core/auto-code/harness/events.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FOLDER_ID = 'fld_test';
export const TICKET_ID = 'note_test';
export const REPO_PATH = '/tmp/morion-test-repo';
export const WORKTREE_PATH = '/tmp/morion-test-repo/.morion/worktrees/auto-x';
export const TRANSCRIPT_DIR = '/tmp/morion-test-transcripts';

export const TICKET_CTX = {
  id: TICKET_ID,
  title: 'Tetris',
  body: 'Build a tetris HTML page',
};

// ---------------------------------------------------------------------------
// Stock workflow definitions
// ---------------------------------------------------------------------------

export const TWO_STAGE: WorkflowDefinition = parseLinearWorkflow({
  schemaVersion: 1,
  name: 'Two-stage test',
  stages: [
    {
      id: 'fix',
      kind: 'cli_agent',
      agent: 'claude',
      promptTemplate: 'Fix {{ticket.title}}',
      maxBudgetUsd: 2,
      maxAttempts: 1,
      allowedTools: ['Read', 'Write'],
    },
    {
      id: 'review',
      kind: 'cli_agent',
      agent: 'codex',
      promptTemplate: 'Review {{stages.fix.output.summary}}',
      maxBudgetUsd: 1,
      maxAttempts: 1,
      allowedTools: [],
    },
  ],
  edges: [{ from: 'fix', to: 'review', on: 'success' }],
});

export const ONE_STAGE: WorkflowDefinition = parseLinearWorkflow({
  schemaVersion: 1,
  name: 'One-stage test',
  stages: [
    {
      id: 'fix',
      kind: 'cli_agent',
      agent: 'claude',
      promptTemplate: 'Fix {{ticket.title}}',
      maxBudgetUsd: 2,
      maxAttempts: 1,
      allowedTools: [],
    },
  ],
});

// ---------------------------------------------------------------------------
// Per-test database setup
// ---------------------------------------------------------------------------

export interface Ctx {
  db: Database.Database;
  repo: WorkflowRunsRepository;
}

export function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  handle.db
    .prepare(`INSERT INTO folders (id, name, position, created_at) VALUES (?, ?, 0, ?)`)
    .run(FOLDER_ID, 'Test', Date.now());
  handle.db
    .prepare(
      `INSERT INTO notes (id, folder_id, title, body, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'user', ?, ?)`,
    )
    .run(TICKET_ID, FOLDER_ID, 'Tetris', 'Build a tetris HTML page', Date.now(), Date.now());
  return { db: handle.db, repo: new WorkflowRunsRepository(handle.db) };
}

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

export interface MockBehavior {
  /** Events to emit in order before terminal. */
  prelude?: CliAgentEvent[];
  /** Terminal event (result or error). */
  terminal: ResultEvent | ErrorEvent;
  /** Delay (ms) before emitting terminal — useful for cancel-mid-run tests. */
  terminalDelay?: number;
  /** Hook called on adapter.spawn() — lets tests observe SpawnOptions.
   *  Returning a Promise blocks spawn() until it resolves; useful for
   *  testing races between cancel() and a freshly-resolved handle. */
  onSpawn?: (opts: SpawnOptions) => void | Promise<void>;
  /** When set, cancel() will await this delay before emitting killed. */
  cancelDelay?: number;
  /** If true, spawn() throws — simulates AgentSpawnError. */
  throwOnSpawn?: Error;
}

export class MockAdapter implements CliAgentAdapter {
  constructor(public readonly name: AgentName, private readonly behavior: MockBehavior) {}

  async spawn(opts: SpawnOptions): Promise<AgentHandle> {
    const onSpawnResult = this.behavior.onSpawn?.(opts);
    if (onSpawnResult && typeof onSpawnResult === 'object' && 'then' in onSpawnResult) {
      await onSpawnResult;
    }
    if (this.behavior.throwOnSpawn) throw this.behavior.throwOnSpawn;

    const sessionId = opts.sessionId ?? `mock-session-${Math.random().toString(36).slice(2)}`;
    const agentName = this.name;
    let cancelRequested = false;
    let cost = 0;
    const events: CliAgentEvent[] = [
      {
        kind: 'session_start',
        sessionId,
        agent: agentName,
        timestamp: Date.now(),
      },
      ...(this.behavior.prelude ?? []),
    ];

    let resolveExited!: () => void;
    const exited = new Promise<void>((r) => {
      resolveExited = r;
    });

    const behavior = this.behavior;
    async function* eventStream(): AsyncIterable<CliAgentEvent> {
      try {
        for (const ev of events) {
          yield ev;
        }
        if (behavior.terminalDelay) {
          await new Promise((r) => setTimeout(r, behavior.terminalDelay));
        }
        if (cancelRequested) {
          const killed: ErrorEvent = {
            kind: 'error',
            errorKind: 'killed',
            message: 'cancelled by handle.cancel()',
            recoverable: false,
            timestamp: Date.now(),
          };
          yield killed;
        } else {
          yield behavior.terminal;
          if (behavior.terminal.kind === 'result') cost = behavior.terminal.costUsd;
        }
      } finally {
        // Runs whether the consumer iterates to completion OR breaks
        // out of the for-await loop after the terminal event. Without
        // this `handle.exited` would hang because consumeUntilTerminal
        // breaks on the first terminal yield and never advances the
        // generator past the final point.
        resolveExited();
      }
    }

    const handle: AgentHandle = {
      adapter: agentName,
      sessionId,
      pid: 12345,
      exited,
      events: eventStream(),
      cancel: async (_reason) => {
        cancelRequested = true;
        if (behavior.cancelDelay) await new Promise((r) => setTimeout(r, behavior.cancelDelay));
      },
      resume: async () => {
        throw new Error('not implemented in mock');
      },
      getCost: () => cost,
    };
    return handle;
  }
}

export function buildAdapterFactory(
  behaviors: Partial<Record<CliAgentName, MockBehavior>>,
): (agent: CliAgentName) => CliAgentAdapter {
  return (agent) => {
    const behavior = behaviors[agent];
    if (!behavior) throw new Error(`mock: no behavior wired for agent ${agent}`);
    return new MockAdapter(agent, behavior);
  };
}

// ---------------------------------------------------------------------------
// Event-shape builders
// ---------------------------------------------------------------------------

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

export function makeError(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    kind: 'error',
    errorKind: 'spawn_failed',
    message: 'broken',
    recoverable: false,
    timestamp: Date.now(),
    ...overrides,
  };
}
