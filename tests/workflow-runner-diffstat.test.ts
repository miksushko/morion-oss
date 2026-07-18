import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { openDb } from '../src/core/db/client.js';
import { WorkflowRunsRepository } from '../src/core/auto-code/workflows/runs-repository.js';
import { WorkflowRunner } from '../src/core/auto-code/workflows/runner.js';
import { parseDraftWorkflow } from '../src/core/auto-code/workflows/parse-linear.js';
import { realWorktreeDiffCapture } from '../src/core/auto-code/workflows/worktree-diff.js';
import type { WorktreeDiffCapture } from '../src/core/auto-code/workflows/worktree-diff.js';
import type {
  CliAgentName,
  WorkflowDefinition,
} from '../src/core/auto-code/workflows/types/index.js';
import type {
  AgentHandle,
  CliAgentAdapter,
  SpawnOptions,
} from '../src/core/auto-code/harness/adapter.js';
import type {
  CliAgentEvent,
  ResultEvent,
} from '../src/core/auto-code/harness/events.js';
import type { MoStageDispatcher } from '../src/core/auto-code/workflows/mo-stage-dispatcher.js';

/**
 * Deterministic handoff — "Mo = router, not narrator" epic.
 *
 * Part 1: the real git-backed capture against a fixture repo.
 * Part 2: the runner enriches cli_agent outputs with diffstat /
 * filesChanged (stubbed capture) and downstream templates can render
 * them.
 */

function gitIn(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

describe('realWorktreeDiffCapture', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'morion-diffstat-'));
    gitIn(repoDir, ['init', '-q']);
    gitIn(repoDir, ['config', 'user.email', 'test@morion.local']);
    gitIn(repoDir, ['config', 'user.name', 'Test']);
    writeFileSync(join(repoDir, 'game.js'), 'const board = [];\n');
    gitIn(repoDir, ['add', '.']);
    gitIn(repoDir, ['commit', '-qm', 'init']);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('captures uncommitted + untracked changes against the pre-stage sha', async () => {
    const base = await realWorktreeDiffCapture.headSha(repoDir);
    expect(base).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(join(repoDir, 'game.js'), 'const board = [];\nrotate();\n');
    writeFileSync(join(repoDir, 'rotate.js'), 'export function rotate() {}\n');

    const diff = await realWorktreeDiffCapture.diffSince(repoDir, base);
    expect(diff).not.toBeNull();
    expect(diff!.diffstat).toContain('game.js');
    expect(diff!.diffstat).toContain('Untracked files: rotate.js');
    expect(diff!.filesChanged).toEqual(['game.js', 'rotate.js']);
  });

  it('captures committed work too (diff vs pre-stage sha survives a commit)', async () => {
    const base = await realWorktreeDiffCapture.headSha(repoDir);
    writeFileSync(join(repoDir, 'game.js'), 'const board = [[]];\n');
    gitIn(repoDir, ['add', '.']);
    gitIn(repoDir, ['commit', '-qm', 'agent work']);

    const diff = await realWorktreeDiffCapture.diffSince(repoDir, base);
    expect(diff!.diffstat).toContain('game.js');
    expect(diff!.filesChanged).toEqual(['game.js']);
  });

  it('reports "(no file changes detected)" on a clean tree', async () => {
    const base = await realWorktreeDiffCapture.headSha(repoDir);
    const diff = await realWorktreeDiffCapture.diffSince(repoDir, base);
    expect(diff!.diffstat).toBe('(no file changes detected)');
    expect(diff!.filesChanged).toEqual([]);
  });

  it('returns null for a non-repo path (never throws)', async () => {
    expect(await realWorktreeDiffCapture.headSha('/tmp/definitely-not-a-repo-xyz')).toBeNull();
    expect(
      await realWorktreeDiffCapture.diffSince('/tmp/definitely-not-a-repo-xyz', null),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Runner integration — stubbed capture
// ---------------------------------------------------------------------

const FOLDER_ID = 'fld_ds';
const TICKET_ID = 'note_ds';

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
    .run(TICKET_ID, FOLDER_ID, 'Tetris', 'tetris', Date.now(), Date.now());
  return { db: handle.db, repo: new WorkflowRunsRepository(handle.db) };
}

class LoggingAdapter implements CliAgentAdapter {
  public spawns: SpawnOptions[] = [];
  constructor(
    public readonly name: CliAgentName,
    private readonly summary: string,
  ) {}
  async spawn(opts: SpawnOptions): Promise<AgentHandle> {
    this.spawns.push(opts);
    const terminal: ResultEvent = {
      kind: 'result',
      exitCode: 0,
      summary: this.summary,
      costUsd: 0,
      terminalReason: 'completed',
      timestamp: Date.now(),
    };
    const sessionId = `mock-${this.name}-${this.spawns.length}`;
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

function fixReviewWorkflow(): WorkflowDefinition {
  return parseDraftWorkflow({
    schemaVersion: 1,
    name: 'diffstat-handoff',
    stages: [
      {
        id: 'start', kind: 'mo_stage', isStart: true, instruction: 'gate',
        branches: ['accept', 'reject'], postComment: true, allowedTools: [],
      },
      {
        id: 'fix', kind: 'cli_agent', agent: 'claude',
        promptTemplate: 'fix {{ticket.title}}',
        maxBudgetUsd: 1, maxAttempts: 1, allowedTools: [],
      },
      {
        id: 'mo_after_fix', kind: 'mo_stage', instruction: 'route',
        branches: ['review', 'reject'], postComment: true, allowedTools: [],
      },
      {
        id: 'review', kind: 'cli_agent', agent: 'codex',
        promptTemplate:
          'review\nSummary: {{stages.fix.output.summary}}\nFiles:\n{{stages.fix.output.diffstat}}',
        maxBudgetUsd: 1, maxAttempts: 1, allowedTools: [],
      },
      {
        id: 'mo_after_review', kind: 'mo_stage', instruction: 'verdict',
        branches: ['approve', 'reject'], postComment: true, allowedTools: [],
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
      { from: 'mo_after_review', to: 'reject_t', on: 'reject' },
    ],
  });
}

const AUTO_ACCEPT_MO: MoStageDispatcher = {
  async decide(input) {
    const first = input.stage.branches?.[0] ?? 'accept';
    return { ok: true, branch: first, reason: 'ok', costUsd: 0 };
  },
};

describe('WorkflowRunner — diffstat handoff', () => {
  it('enriches cli_agent output with diffstat/filesChanged and renders them downstream', async () => {
    const { repo } = setup();
    const fixer = new LoggingAdapter('claude', 'implemented rotation');
    const reviewer = new LoggingAdapter('codex', 'looks good');
    const stubCapture: WorktreeDiffCapture = {
      headSha: async () => 'basesha',
      diffSince: async () => ({
        diffstat: ' game.js | 2 +-\n rotate.js | 5 +++++',
        filesChanged: ['game.js', 'rotate.js'],
      }),
    };
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: (a) => (a === 'claude' ? fixer : reviewer),
      transcriptDir: '/tmp/morion-ds-transcripts',
      moStageDispatcher: AUTO_ACCEPT_MO,
      worktreeDiff: stubCapture,
    });
    const handle = await runner.start({
      definition: fixReviewWorkflow(),
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      ticketContext: { id: TICKET_ID, title: 'Tetris', body: 'tetris' },
      worktreePath: '/tmp/morion-ds-repo/.morion/worktrees/auto-x',
      repoPath: '/tmp/morion-ds-repo',
    });
    const row = await handle.awaitTerminal();
    expect(row.status).toBe('done');

    // Reviewer prompt rendered both the fixer's words AND the facts.
    const reviewPrompt = reviewer.spawns[0].prompt;
    expect(reviewPrompt).toContain('implemented rotation');
    expect(reviewPrompt).toContain('rotate.js | 5 +++++');

    // Persisted stage output carries the enrichment.
    const stages = repo.listStagesForRun(row.id);
    const fixRow = stages.find((s) => s.stageIdInGraph === 'fix');
    const output = fixRow?.output as Record<string, unknown>;
    expect(output.summary).toBe('implemented rotation');
    expect(output.diffstat).toContain('game.js');
    expect(output.filesChanged).toEqual(['game.js', 'rotate.js']);
  });

  it('omits the fields (and never fails the run) when capture yields null', async () => {
    const { repo } = setup();
    const fixer = new LoggingAdapter('claude', 'implemented');
    const reviewer = new LoggingAdapter('codex', 'ok');
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: (a) => (a === 'claude' ? fixer : reviewer),
      transcriptDir: '/tmp/morion-ds-transcripts',
      moStageDispatcher: AUTO_ACCEPT_MO,
      // Default real capture on a nonexistent path → null → omitted.
    });
    const handle = await runner.start({
      definition: fixReviewWorkflow(),
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      ticketContext: { id: TICKET_ID, title: 'Tetris', body: 'tetris' },
      worktreePath: '/tmp/definitely-not-a-repo-xyz/wt',
      repoPath: '/tmp/definitely-not-a-repo-xyz',
    });
    const row = await handle.awaitTerminal();
    expect(row.status).toBe('done');
    const stages = repo.listStagesForRun(row.id);
    const fixRow = stages.find((s) => s.stageIdInGraph === 'fix');
    const output = fixRow?.output as Record<string, unknown>;
    expect(output.summary).toBe('implemented');
    expect(output.diffstat).toBeUndefined();
  });
});
