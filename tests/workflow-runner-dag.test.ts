import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { openDb } from '../src/core/db/client.js';
import { WorkflowRunsRepository } from '../src/core/auto-code/workflows/runs-repository.js';
import {
  WorkflowRunner,
  REJECTED_BY_WORKFLOW_PREFIX,
  type RunnerHooks,
} from '../src/core/auto-code/workflows/runner.js';
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
import type { CliAgentEvent, ResultEvent } from '../src/core/auto-code/harness/events.js';

/**
 * Phase 4 DAG runner — focused tests on the new behaviours:
 *   - mo_stage decision dispatch + branch routing
 *   - reject_sink / complete_sink terminal handling
 *   - cli_agent v2 fields (provider / model / level / agentInstruction)
 *     flow through to adapter.spawn SpawnOptions
 *   - rejected_by_workflow lastError prefix on reject_sink termination
 */

const FOLDER_ID = 'fld_dag';
const TICKET_ID = 'note_dag';
const REPO_PATH = '/tmp/morion-dag-repo';
const WORKTREE_PATH = '/tmp/morion-dag-repo/.morion/worktrees/auto-x';
const TRANSCRIPT_DIR = '/tmp/morion-dag-transcripts';

interface Ctx {
  db: Database.Database;
  repo: WorkflowRunsRepository;
}

function setup(): Ctx {
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

class MockAdapter implements CliAgentAdapter {
  public lastOpts: SpawnOptions | null = null;
  constructor(
    public readonly name: 'claude' | 'codex' | 'pi' | 'opencode',
    private readonly terminal: ResultEvent = makeResult(),
  ) {}
  async spawn(opts: SpawnOptions): Promise<AgentHandle> {
    this.lastOpts = opts;
    const sessionId = `mock-${Math.random().toString(36).slice(2)}`;
    const terminal = this.terminal;
    const events: CliAgentEvent[] = [
      { kind: 'session_start', sessionId, agent: this.name, timestamp: Date.now() },
    ];
    let resolveExited!: () => void;
    const exited = new Promise<void>((r) => (resolveExited = r));
    async function* stream(): AsyncIterable<CliAgentEvent> {
      try {
        for (const ev of events) yield ev;
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
      getCost: () => (terminal.kind === 'result' ? terminal.costUsd : 0),
    };
  }
}

function buildAdapters(mocks: Partial<Record<CliAgentName, MockAdapter>>): {
  factory: (a: CliAgentName) => CliAgentAdapter;
  mocks: Partial<Record<CliAgentName, MockAdapter>>;
} {
  return {
    factory: (a) => {
      const m = mocks[a];
      if (!m) throw new Error(`no mock for ${a}`);
      return m;
    },
    mocks,
  };
}

function stubMoDispatcher(
  pick: (input: { stageId: string }) => MoStageDispatchResult,
): MoStageDispatcher {
  return {
    async decide(input) {
      return pick({ stageId: input.stage.id });
    },
  };
}

function v2Workflow(): WorkflowDefinition {
  return parseDraftWorkflow({
    schemaVersion: 1,
    name: 'v2-test',
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
        promptTemplate: 'fix {{ticket.title}}',
        maxBudgetUsd: 1,
        maxAttempts: 1,
        allowedTools: [],
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        level: 'ThinkHard',
        agentInstruction: 'Read CLAUDE.md first.',
      },
      {
        id: 'reject_t',
        kind: 'reject_sink',
        commentTemplate: 'Rejected: ticket too vague.',
      },
      {
        id: 'complete_t',
        kind: 'complete_sink',
        commentTemplate: 'Done!',
      },
    ],
    edges: [
      { from: 'start', to: 'fix', on: 'accept' },
      { from: 'start', to: 'reject_t', on: 'reject' },
      { from: 'fix', to: 'complete_t', on: 'success' },
    ],
  });
}

const TICKET = { id: TICKET_ID, title: 'Tetris', body: 'tetris' };

describe('WorkflowRunner — DAG dispatch (Phase 4)', () => {
  it('mo_stage picks "accept" → fix runs → complete_sink → run.done', async () => {
    const { repo } = setup();
    const claudeMock = new MockAdapter('claude', makeResult({ summary: 'fixed', costUsd: 0.5 }));
    const { factory } = buildAdapters({ claude: claudeMock });
    const moDispatcher = stubMoDispatcher(() => ({
      ok: true,
      branch: 'accept',
      reason: 'looks good',
      costUsd: 0.01,
    }));
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
      moStageDispatcher: moDispatcher,
    });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: v2Workflow(),
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET,
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('done');
    expect(final.lastError).toBeNull();
    // Verify v2 fields plumbed into spawn options.
    expect(claudeMock.lastOpts?.provider).toBe('anthropic');
    expect(claudeMock.lastOpts?.model).toBe('claude-opus-4-7');
    expect(claudeMock.lastOpts?.level).toBe('ThinkHard');
    expect(claudeMock.lastOpts?.prompt).toContain('Read CLAUDE.md first.');
    expect(claudeMock.lastOpts?.prompt).toContain('fix Tetris');
    // Stage rollup includes mo decision cost + fix cost.
    expect(final.totalCostUsd).toBeCloseTo(0.51, 5);
    // Stage rows recorded.
    const stages = repo.listStagesForRun(final.id);
    const kinds = stages.map((s) => s.stageKind).sort();
    expect(kinds).toEqual(['cli_agent', 'complete_sink', 'mo_stage']);
  });

  it('mo_stage picks "reject" → reject_sink → run.failed with rejected_by_workflow prefix', async () => {
    const { repo } = setup();
    const { factory } = buildAdapters({ claude: new MockAdapter('claude') });
    const moDispatcher = stubMoDispatcher(() => ({
      ok: true,
      branch: 'reject',
      reason: 'ticket too vague',
    }));
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
      moStageDispatcher: moDispatcher,
    });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: v2Workflow(),
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET,
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('failed');
    expect(final.lastError ?? '').toContain(REJECTED_BY_WORKFLOW_PREFIX);
    expect(final.lastError ?? '').toContain('Rejected: ticket too vague.');
    const stages = repo.listStagesForRun(final.id);
    // fix never ran; only mo_stage + reject_sink.
    const kinds = stages.map((s) => s.stageKind).sort();
    expect(kinds).toEqual(['mo_stage', 'reject_sink']);
    // reject_sink stage row carries rendered comment on output.comment.
    const sinkRow = stages.find((s) => s.stageKind === 'reject_sink');
    expect(sinkRow?.output).toMatchObject({
      sinkKind: 'reject',
      comment: 'Rejected: ticket too vague.',
    });
  });

  it('mo_stage failure (default dispatcher unwired) terminates run with clear envelope', async () => {
    const { repo } = setup();
    const { factory } = buildAdapters({ claude: new MockAdapter('claude') });
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
      // No moStageDispatcher injected → default failing stub fires.
    });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: v2Workflow(),
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET,
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('failed');
    expect(final.lastError ?? '').toContain('mo_stage_dispatcher_not_wired');
  });

  it('mo_stage decision picking unknown branch fails clean', async () => {
    const { repo } = setup();
    const { factory } = buildAdapters({ claude: new MockAdapter('claude') });
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
      moStageDispatcher: stubMoDispatcher(() => ({
        ok: true,
        branch: 'maybe',
        reason: 'huh',
      })),
    });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: v2Workflow(),
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET,
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('failed');
    expect(final.lastError ?? '').toContain('mo_stage_invalid_branch');
  });

  it('runner hooks fire for mo_stage + sink stages just like for cli_agent', async () => {
    const { repo } = setup();
    const { factory } = buildAdapters({
      claude: new MockAdapter('claude', makeResult({ summary: 'fixed' })),
    });
    const seenStageKinds: string[] = [];
    const hooks: RunnerHooks = {
      onStageStart: ({ stageRow }) => {
        seenStageKinds.push(`start:${stageRow.stageKind}`);
      },
      onStageEnd: ({ stageRow }) => {
        seenStageKinds.push(`end:${stageRow.stageKind}`);
      },
    };
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
      moStageDispatcher: stubMoDispatcher(() => ({
        ok: true,
        branch: 'accept',
        reason: 'ok',
      })),
    });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: v2Workflow(),
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET,
      hooks,
    });
    await handle.awaitTerminal();
    // Each of mo_stage (start), cli_agent (fix), complete_sink should
    // have fired both start + end hooks.
    expect(seenStageKinds).toEqual([
      'start:mo_stage',
      'end:mo_stage',
      'start:cli_agent',
      'end:cli_agent',
      'start:complete_sink',
      'end:complete_sink',
    ]);
  });
});
