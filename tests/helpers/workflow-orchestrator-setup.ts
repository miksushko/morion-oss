import { mkdirSync } from 'node:fs';

import type Database from 'better-sqlite3';

import { openDb } from '../../src/core/db/client.js';
import { AuditLogger } from '../../src/core/audit/log.js';
import { ConciergeFolderSettingsRepository } from '../../src/core/concierge/folder-settings-repository.js';
import { FoldersRepository } from '../../src/core/folders/repository.js';
import { NoteCommentsRepository } from '../../src/core/notes/comments-repository.js';
import { NotesRepository } from '../../src/core/notes/repository.js';

import { WorkflowRunsRepository } from '../../src/core/auto-code/workflows/runs-repository.js';
import { WorkflowRunner } from '../../src/core/auto-code/workflows/runner.js';
import { WorkflowOrchestrator } from '../../src/core/auto-code/workflows/workflow-orchestrator.js';
import type { WorkflowDefinition } from '../../src/core/auto-code/workflows/types/index.js';
import type {
  AgentHandle,
  CliAgentAdapter,
  SpawnOptions,
} from '../../src/core/auto-code/harness/adapter.js';
import type {
  AgentName,
  CliAgentEvent,
  ResultEvent,
} from '../../src/core/auto-code/harness/events.js';
import type { PreflightResult } from '../../src/core/auto-code/preflight.js';

/**
 * Shared test setup for the WorkflowOrchestrator scenario suites
 * (originally inlined in tests/workflow-orchestrator.test.ts before
 * the 2026-05-16 split — Morion ticket 01KRJZ1DKDRKVAV2YDDZVG3152).
 *
 * Builds an in-memory SQLite DB + the orchestrator's full repository
 * graph + a stubbed `MockAdapter` / `WorkflowRunner` factory + the
 * `buildOrchestrator` helper that wires everything into a
 * `WorkflowOrchestrator` instance ready for assertions.
 */

export const FOLDER_NAME = 'Test';
export const TICKET_TITLE = 'Build a tetris page';
export const TICKET_BODY =
  'Acceptance criteria: 10×20 grid, 7 tetrominoes, arrow controls.';
export const REPO_PATH = '/tmp/morion-test-repo';
export const TRANSCRIPT_DIR = '/tmp/morion-test-transcripts';

// Admission validates that the linked repo path exists on disk before
// claiming a run (so a deleted/moved repo rejects cleanly instead of
// failing later with a cryptic `spawn git ENOENT`). Materialise the
// stub repo dir so the happy-path suites pass that gate — git itself
// is never invoked (ensureWorktree is stubbed in buildOrchestrator).
mkdirSync(REPO_PATH, { recursive: true });

export interface Ctx {
  db: Database.Database;
  notes: NotesRepository;
  folders: FoldersRepository;
  comments: NoteCommentsRepository;
  audit: AuditLogger;
  folderSettings: ConciergeFolderSettingsRepository;
  runsRepo: WorkflowRunsRepository;
  folderId: string;
  ticketId: string;
}

export function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const folders = new FoldersRepository(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const comments = new NoteCommentsRepository(handle.db);
  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const runsRepo = new WorkflowRunsRepository(handle.db);

  const folder = folders.create(FOLDER_NAME);
  const task = notes.create(
    {
      body: `# ${TICKET_TITLE}\n\n${TICKET_BODY}`,
      folderId: folder.id,
      source: 'user',
    },
    'user',
  );
  notes.moveToKanban(task.id, 'todo', null, 'user');
  return {
    db: handle.db,
    notes,
    folders,
    comments,
    audit,
    folderSettings,
    runsRepo,
    folderId: folder.id,
    ticketId: task.id,
  };
}

export interface MockBehavior {
  terminal: ResultEvent;
  onSpawn?: (opts: SpawnOptions) => void;
}

export class MockAdapter implements CliAgentAdapter {
  constructor(
    public readonly name: AgentName,
    private readonly behavior: MockBehavior,
  ) {}

  async spawn(opts: SpawnOptions): Promise<AgentHandle> {
    this.behavior.onSpawn?.(opts);
    const sessionId = opts.sessionId ?? `mock-${Math.random().toString(36).slice(2)}`;
    const events: CliAgentEvent[] = [
      { kind: 'session_start', sessionId, agent: this.name, timestamp: Date.now() },
    ];
    let resolveExited!: () => void;
    const exited = new Promise<void>((r) => {
      resolveExited = r;
    });
    const terminal = this.behavior.terminal;
    async function* eventStream(): AsyncIterable<CliAgentEvent> {
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
      events: eventStream(),
      cancel: async () => {},
      resume: async () => {
        throw new Error('not implemented');
      },
      getCost: () => terminal.costUsd,
    };
  }
}

export function makeResult(overrides: Partial<ResultEvent> = {}): ResultEvent {
  return {
    kind: 'result',
    exitCode: 0,
    summary: 'done',
    costUsd: 0.1,
    terminalReason: 'completed',
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeRunner(ctx: Ctx, terminalCostUsd: number = 0.1): WorkflowRunner {
  const factory = (_agent: 'claude' | 'codex' | 'pi' | 'opencode') => {
    return new MockAdapter(_agent, {
      terminal: {
        kind: 'result',
        exitCode: 0,
        summary: '{"verdict":"approve","reason":"ok"}',
        costUsd: terminalCostUsd,
        terminalReason: 'completed',
        timestamp: Date.now(),
      },
    });
  };
  return new WorkflowRunner({
    repo: ctx.runsRepo,
    adapterFactory: factory,
    transcriptDir: TRANSCRIPT_DIR,
  });
}

export const STUB_PREFLIGHT_OK: PreflightResult = {
  blocking: [],
  warnings: [],
  claude: {
    found: true,
    path: '/usr/local/bin/claude',
    version: '1.x',
    sourceHint: 'PATH',
  },
  codex: {
    found: true,
    path: '/usr/local/bin/codex',
    version: '0.1.x',
    sourceHint: 'PATH',
  },
  morionMcpClaude: { configured: true, scopeHint: 'global' },
  morionMcpCodex: { configured: true, scopeHint: 'global' },
};

export function buildOrchestrator(
  ctx: Ctx,
  overrides: Partial<{
    runner: WorkflowRunner;
    preflight: PreflightResult;
    ensureWorktreeThrows: Error;
    maxInflightPerFolder: number;
    isAgentAvailable: (agent: string) => boolean;
    resolveDefinition: (folderId: string) => WorkflowDefinition;
  }> = {},
): WorkflowOrchestrator {
  const runner = overrides.runner ?? makeRunner(ctx);
  return new WorkflowOrchestrator({
    db: ctx.db,
    notes: ctx.notes,
    folders: ctx.folders,
    comments: ctx.comments,
    audit: ctx.audit,
    folderSettings: ctx.folderSettings,
    runsRepo: ctx.runsRepo,
    runner,
    maxInflightPerFolder: overrides.maxInflightPerFolder,
    preflightImpl: () => overrides.preflight ?? STUB_PREFLIGHT_OK,
    ensureWorktree: async () => {
      if (overrides.ensureWorktreeThrows) throw overrides.ensureWorktreeThrows;
    },
    generateWorktreeName: () => 'auto-fixed-test-id',
    isAgentAvailable: overrides.isAgentAvailable,
    resolveDefinition: overrides.resolveDefinition,
  });
}
