import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { openDb } from '../src/core/db/client.js';
import { WorkflowRunsRepository } from '../src/core/auto-code/workflows/runs-repository.js';
import {
  ACTIVE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from '../src/core/auto-code/workflows/types/index.js';

interface Ctx {
  db: Database.Database;
  repo: WorkflowRunsRepository;
}

const FOLDER_ID = 'fld_test';
const TICKET_ID = 'note_test';
const REPO_PATH = '/tmp/morion-test-repo';
const WORKTREE_PATH = '/tmp/morion-test-repo/.morion/worktrees/auto-x';

const HARDCODED_DEFAULT: WorkflowDefinition = {
  schemaVersion: 1,
  name: 'Default Autocode',
  description: 'L2 hardcoded linear pipeline (claude → codex review → done).',
  stages: [
    {
      id: 'fix',
      kind: 'cli_agent',
      agent: 'claude',
      promptTemplate: 'Fix ticket {{ticket.title}}',
      maxBudgetUsd: 2,
      maxAttempts: 1,
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    },
    {
      id: 'review',
      kind: 'cli_agent',
      agent: 'codex',
      promptTemplate: 'Review the diff produced by stage {{stages.fix.output.diffPath}}',
      maxBudgetUsd: 1,
      maxAttempts: 1,
      allowedTools: [],
    },
  ],
  edges: [{ from: 'fix', to: 'review', on: 'success' }],
};

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
    .run(TICKET_ID, FOLDER_ID, 'Test ticket', 'Test ticket body', Date.now(), Date.now());
  return { db: handle.db, repo: new WorkflowRunsRepository(handle.db) };
}

function defaultCreateInput(overrides: Partial<Parameters<WorkflowRunsRepository['createRun']>[0]> = {}) {
  return {
    folderId: FOLDER_ID,
    ticketId: TICKET_ID,
    graphSnapshot: HARDCODED_DEFAULT,
    repoPath: REPO_PATH,
    worktreePath: WORKTREE_PATH,
    ...overrides,
  };
}

describe('migration 0028 — workflow_runs schema', () => {
  it('creates workflows / workflow_runs / workflow_run_stages tables', () => {
    const { db } = setup();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type='table' AND name IN ('workflows','workflow_runs','workflow_run_stages')
          ORDER BY name`,
      )
      .all() as { name: string }[];
    expect(tables.map((r) => r.name)).toEqual([
      'workflow_run_stages',
      'workflow_runs',
      'workflows',
    ]);
  });

  it('creates the partial active-runs index', () => {
    const { db } = setup();
    const idx = db
      .prepare(
        `SELECT sql FROM sqlite_master
          WHERE type='index' AND name='idx_workflow_runs_active'`,
      )
      .get() as { sql: string } | undefined;
    expect(idx?.sql).toMatch(/WHERE status IN/);
    expect(idx?.sql).toMatch(/'pending'/);
    expect(idx?.sql).toMatch(/'paused_ask_user'/);
  });

  it('creates the partial unique index for active runs per ticket', () => {
    const { db } = setup();
    const idx = db
      .prepare(
        `SELECT sql FROM sqlite_master
          WHERE type='index' AND name='idx_workflow_runs_active_unique'`,
      )
      .get() as { sql: string } | undefined;
    expect(idx?.sql).toBeTruthy();
    expect(idx?.sql).toMatch(/UNIQUE/);
    expect(idx?.sql).toMatch(/folder_id/);
    expect(idx?.sql).toMatch(/ticket_id/);
    expect(idx?.sql).toMatch(/WHERE status NOT IN/);
  });

  it('CHECK constraint rejects unknown run status', () => {
    const { db } = setup();
    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_runs (id, folder_id, ticket_id, graph_snapshot_json,
             repo_path, worktree_path, status, started_at, updated_at)
           VALUES (?, ?, ?, '{}', ?, ?, ?, 0, 0)`,
        )
        .run('r1', FOLDER_ID, TICKET_ID, REPO_PATH, WORKTREE_PATH, 'bogus_status'),
    ).toThrow(/CHECK constraint/);
  });

  it('CHECK constraint rejects negative cost', () => {
    const { db } = setup();
    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_runs (id, folder_id, ticket_id, graph_snapshot_json,
             repo_path, worktree_path, status, total_cost_usd, started_at, updated_at)
           VALUES (?, ?, ?, '{}', ?, ?, 'pending', -1, 0, 0)`,
        )
        .run('r2', FOLDER_ID, TICKET_ID, REPO_PATH, WORKTREE_PATH),
    ).toThrow(/CHECK constraint/);
  });

  it('cascades delete from notes to workflow_runs', () => {
    const { db, repo } = setup();
    repo.createRun(defaultCreateInput());
    db.prepare('DELETE FROM notes WHERE id = ?').run(TICKET_ID);
    const remaining = db
      .prepare('SELECT COUNT(*) AS c FROM workflow_runs')
      .get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  it('cascades delete from workflow_runs to workflow_run_stages', () => {
    const { db, repo } = setup();
    const { run } = repo.createRun(defaultCreateInput());
    repo.createStage({ runId: run.id, stageIdInGraph: 'fix', stageKind: 'cli_agent' });
    db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(run.id);
    const remaining = db
      .prepare('SELECT COUNT(*) AS c FROM workflow_run_stages')
      .get() as { c: number };
    expect(remaining.c).toBe(0);
  });
});

describe('WorkflowDefinitionSchema — refinements', () => {
  it('rejects duplicate stage ids', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'dup',
        stages: [
          { id: 'fix', kind: 'cli_agent', agent: 'claude', promptTemplate: 'a' },
          { id: 'fix', kind: 'cli_agent', agent: 'codex', promptTemplate: 'b' },
        ],
      }),
    ).toThrow(/duplicate stage id/);
  });

  it('rejects edges referencing unknown stage ids', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'dangling',
        stages: [{ id: 'fix', kind: 'cli_agent', agent: 'claude', promptTemplate: 'x' }],
        edges: [{ from: 'fix', to: 'review', on: 'success' }],
      }),
    ).toThrow(/edge\.to/);
  });

  it('accepts a valid linear definition', () => {
    expect(() => WorkflowDefinitionSchema.parse(HARDCODED_DEFAULT)).not.toThrow();
  });
});

describe('WorkflowRunsRepository — runs CRUD', () => {
  it('createRun persists snapshot + repo + worktree + defaults', () => {
    const { repo } = setup();
    const { run, deduped } = repo.createRun(defaultCreateInput(), 1_000_000);
    expect(deduped).toBe(false);
    expect(run.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(run.workflowId).toBeNull();
    expect(run.repoPath).toBe(REPO_PATH);
    expect(run.worktreePath).toBe(WORKTREE_PATH);
    expect(run.status).toBe('pending');
    expect(run.cancelRequested).toBe(false);
    expect(run.totalCostUsd).toBe(0);
    expect(run.startedAt).toBe(1_000_000);
    expect(run.finishedAt).toBeNull();
    expect(run.graphSnapshot.stages).toHaveLength(2);
  });

  it('getRun roundtrips through JSON storage', () => {
    const { repo } = setup();
    const { run } = repo.createRun(defaultCreateInput({ workflowId: 'wf_default' }));
    const fetched = repo.getRun(run.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.workflowId).toBe('wf_default');
    expect(fetched?.graphSnapshot).toEqual(run.graphSnapshot);
    expect(fetched?.repoPath).toBe(REPO_PATH);
    expect(fetched?.worktreePath).toBe(WORKTREE_PATH);
  });

  it('createRun rejects malformed snapshots', () => {
    const { repo } = setup();
    expect(() =>
      repo.createRun(
        defaultCreateInput({
          // @ts-expect-error — intentional invalid stage kind
          graphSnapshot: { schemaVersion: 1, name: 'X', stages: [{ id: 'a', kind: 'bogus' }] },
        }),
      ),
    ).toThrow();
  });

  it('createRun dedupes when an active run already exists for (folder, ticket)', () => {
    const { repo } = setup();
    const first = repo.createRun(defaultCreateInput(), 1000);
    expect(first.deduped).toBe(false);
    const second = repo.createRun(defaultCreateInput(), 2000);
    expect(second.deduped).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    // Original startedAt preserved — not overwritten by the dedupe call.
    expect(second.run.startedAt).toBe(1000);
  });

  it('createRun produces a fresh row when prior runs are all terminal', () => {
    const { repo } = setup();
    const first = repo.createRun(defaultCreateInput({ initialStatus: 'done' }));
    expect(first.deduped).toBe(false);
    const second = repo.createRun(defaultCreateInput());
    expect(second.deduped).toBe(false);
    expect(second.run.id).not.toBe(first.run.id);
  });

  it('partial unique index rejects raw SQL double-active inserts', () => {
    const { db, repo } = setup();
    repo.createRun(defaultCreateInput());
    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_runs (id, folder_id, ticket_id, graph_snapshot_json,
             repo_path, worktree_path, status, started_at, updated_at)
           VALUES (?, ?, ?, '{}', ?, ?, 'running', 0, 0)`,
        )
        .run('manual', FOLDER_ID, TICKET_ID, REPO_PATH, WORKTREE_PATH),
    ).toThrow(/UNIQUE constraint/);
  });

  it('findActiveRunForTicket returns the in-flight row, ignores terminal', () => {
    const { repo } = setup();
    expect(repo.findActiveRunForTicket(FOLDER_ID, TICKET_ID)).toBeNull();
    const { run } = repo.createRun(defaultCreateInput());
    expect(repo.findActiveRunForTicket(FOLDER_ID, TICKET_ID)?.id).toBe(run.id);
    repo.updateRun(run.id, { status: 'done', finishedAt: Date.now() });
    expect(repo.findActiveRunForTicket(FOLDER_ID, TICKET_ID)).toBeNull();
  });

  it('listRunsForTicket returns newest-first', () => {
    const { repo } = setup();
    const a = repo.createRun(defaultCreateInput({ initialStatus: 'done' }), 1000);
    const b = repo.createRun(defaultCreateInput(), 2000);
    const list = repo.listRunsForTicket(TICKET_ID);
    expect(list.map((r) => r.id)).toEqual([b.run.id, a.run.id]);
  });

  it('listActiveRuns excludes terminal', () => {
    const { repo } = setup();
    // Two distinct tickets so the active-unique index doesn't merge them.
    const ticket2 = 'note_test_2';
    const ctx2 = setup();
    ctx2.db
      .prepare(
        `INSERT INTO notes (id, folder_id, title, body, source, created_at, updated_at)
           VALUES (?, ?, 'T2', 'b', 'user', 0, 0)`,
      )
      .run(ticket2, FOLDER_ID);
    const active = ctx2.repo.createRun(defaultCreateInput({ initialStatus: 'running' }));
    const done = ctx2.repo.createRun(
      defaultCreateInput({ ticketId: ticket2, initialStatus: 'done' }),
    );
    const list = ctx2.repo.listActiveRuns();
    const ids = list.map((r) => r.id);
    expect(ids).toContain(active.run.id);
    expect(ids).not.toContain(done.run.id);
  });

  it('countActiveRunsInFolder counts only non-terminal', () => {
    const { db, repo } = setup();
    // Need three tickets to register three active rows (active-unique index
    // collapses on (folder, ticket)).
    const t2 = 'note_t2';
    const t3 = 'note_t3';
    db.prepare(
      `INSERT INTO notes (id, folder_id, title, body, source, created_at, updated_at)
         VALUES (?, ?, 'T', 'b', 'user', 0, 0)`,
    ).run(t2, FOLDER_ID);
    db.prepare(
      `INSERT INTO notes (id, folder_id, title, body, source, created_at, updated_at)
         VALUES (?, ?, 'T', 'b', 'user', 0, 0)`,
    ).run(t3, FOLDER_ID);
    repo.createRun(defaultCreateInput({ initialStatus: 'pending' }));
    repo.createRun(defaultCreateInput({ ticketId: t2, initialStatus: 'running' }));
    repo.createRun(defaultCreateInput({ ticketId: t3, initialStatus: 'done' }));
    expect(repo.countActiveRunsInFolder(FOLDER_ID)).toBe(2);
  });

  it('updateRun applies a partial patch + bumps updated_at', () => {
    const { repo } = setup();
    const { run } = repo.createRun(defaultCreateInput(), 1000);
    repo.updateRun(
      run.id,
      {
        status: 'running',
        currentStageId: 'fix',
        cancelRequested: true,
        totalCostUsd: 0.42,
      },
      2000,
    );
    const after = repo.getRun(run.id)!;
    expect(after.status).toBe('running');
    expect(after.currentStageId).toBe('fix');
    expect(after.cancelRequested).toBe(true);
    expect(after.totalCostUsd).toBe(0.42);
    expect(after.updatedAt).toBe(2000);
  });

  it('updateRun no-ops on empty patch', () => {
    const { repo } = setup();
    const { run } = repo.createRun(defaultCreateInput(), 1000);
    repo.updateRun(run.id, {}, 9999);
    const after = repo.getRun(run.id)!;
    expect(after.updatedAt).toBe(1000);
  });

  it('TERMINAL and ACTIVE status sets are disjoint and cover known statuses', () => {
    for (const s of ACTIVE_RUN_STATUSES) {
      expect(TERMINAL_RUN_STATUSES.has(s)).toBe(false);
    }
    expect(ACTIVE_RUN_STATUSES.size + TERMINAL_RUN_STATUSES.size).toBe(6);
  });
});

describe('WorkflowRunsRepository — stages CRUD', () => {
  it('createStage records snapshot stage + attempt defaults', () => {
    const { repo } = setup();
    const { run } = repo.createRun(defaultCreateInput());
    const stage = repo.createStage(
      {
        runId: run.id,
        stageIdInGraph: 'fix',
        stageKind: 'cli_agent',
        agentName: 'claude',
        sessionId: 'sess_1',
        transcriptPath: '/tmp/runs/x.jsonl',
      },
      5000,
    );
    expect(stage.attempt).toBe(1);
    expect(stage.status).toBe('pending');
    expect(stage.activePid).toBeNull();
    expect(stage.agentName).toBe('claude');
    expect(stage.sessionId).toBe('sess_1');
    expect(stage.transcriptPath).toBe('/tmp/runs/x.jsonl');
    expect(stage.startedAt).toBe(5000);
  });

  it('CHECK constraint rejects unknown stage_kind', () => {
    const { db, repo } = setup();
    const { run } = repo.createRun(defaultCreateInput());
    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_run_stages (id, run_id, stage_id_in_graph, stage_kind,
             status, started_at, updated_at)
           VALUES ('s1', ?, 'fix', 'bogus', 'pending', 0, 0)`,
        )
        .run(run.id),
    ).toThrow(/CHECK constraint/);
  });

  it('CHECK constraint rejects unknown agent_name', () => {
    const { db, repo } = setup();
    const { run } = repo.createRun(defaultCreateInput());
    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_run_stages (id, run_id, stage_id_in_graph, stage_kind,
             agent_name, status, started_at, updated_at)
           VALUES ('s2', ?, 'fix', 'cli_agent', 'gpt-bogus', 'pending', 0, 0)`,
        )
        .run(run.id),
    ).toThrow(/CHECK constraint/);
  });

  it('CHECK constraint rejects attempt < 1', () => {
    const { db, repo } = setup();
    const { run } = repo.createRun(defaultCreateInput());
    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_run_stages (id, run_id, stage_id_in_graph, stage_kind,
             status, attempt, started_at, updated_at)
           VALUES ('s3', ?, 'fix', 'cli_agent', 'pending', 0, 0, 0)`,
        )
        .run(run.id),
    ).toThrow(/CHECK constraint/);
  });

  it('listStagesForRun returns insertion order', () => {
    const { repo } = setup();
    const { run } = repo.createRun(defaultCreateInput());
    const fix = repo.createStage(
      { runId: run.id, stageIdInGraph: 'fix', stageKind: 'cli_agent' },
      1000,
    );
    const review = repo.createStage(
      { runId: run.id, stageIdInGraph: 'review', stageKind: 'cli_agent' },
      2000,
    );
    expect(repo.listStagesForRun(run.id).map((s) => s.id)).toEqual([fix.id, review.id]);
  });

  it('latestAttemptForStage picks max attempt', () => {
    const { repo } = setup();
    const { run } = repo.createRun(defaultCreateInput());
    repo.createStage({
      runId: run.id,
      stageIdInGraph: 'fix',
      stageKind: 'cli_agent',
      attempt: 1,
    });
    const second = repo.createStage({
      runId: run.id,
      stageIdInGraph: 'fix',
      stageKind: 'cli_agent',
      attempt: 2,
    });
    const latest = repo.latestAttemptForStage(run.id, 'fix');
    expect(latest?.id).toBe(second.id);
    expect(latest?.attempt).toBe(2);
  });

  it('updateStage stores output JSON + clears via null', () => {
    const { repo } = setup();
    const { run } = repo.createRun(defaultCreateInput());
    const stage = repo.createStage({
      runId: run.id,
      stageIdInGraph: 'fix',
      stageKind: 'cli_agent',
    });
    repo.updateStage(stage.id, {
      status: 'done',
      activePid: null,
      costUsd: 0.17,
      output: { verdict: 'approve', diffPath: '/tmp/d.patch' },
      finishedAt: 9000,
    });
    const after = repo.getStage(stage.id)!;
    expect(after.status).toBe('done');
    expect(after.costUsd).toBe(0.17);
    expect(after.output).toEqual({ verdict: 'approve', diffPath: '/tmp/d.patch' });
    expect(after.finishedAt).toBe(9000);

    repo.updateStage(stage.id, { output: null });
    expect(repo.getStage(stage.id)?.output).toBeNull();
  });
});
