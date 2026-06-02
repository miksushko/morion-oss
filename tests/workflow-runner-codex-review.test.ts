import { describe, expect, it } from 'vitest';

import {
  type BudgetGuard,
  type BudgetGuardContext,
  WorkflowRunner,
} from '../src/core/auto-code/workflows/runner.js';
import { type CliAgentName, type WorkflowDefinition } from '../src/core/auto-code/workflows/types/index.js';
import { parseLinearWorkflow } from '../src/core/auto-code/workflows/parse-linear.js';
import { parseVerdict } from '../src/core/auto-code/workflows/verdict.js';
import type { SpawnOptions } from '../src/core/auto-code/harness/adapter.js';
import {
  FOLDER_ID,
  MockAdapter,
  ONE_STAGE,
  REPO_PATH,
  TICKET_CTX,
  TICKET_ID,
  TRANSCRIPT_DIR,
  TWO_STAGE,
  WORKTREE_PATH,
  buildAdapterFactory,
  makeError,
  makeResult,
  setup,
} from './workflow-runner/helpers.js';

describe('WorkflowRunner — Codex review regressions', () => {
  it('cancel() during spawn handshake still kills the freshly-resolved handle', async () => {
    // Reproduces the race: cancel() is called AFTER state.cancelReason
    // would land but BEFORE state.currentAdapterHandle is assigned.
    // The runner must re-check the flag after handle assignment and
    // signal the handle. Without the post-assignment re-check the
    // adapter ran to completion and the run resolved `done` instead
    // of `cancelled` (P1 finding).
    const { repo } = setup();
    let cancelObservedByMock = false;
    let releaseSpawn: () => void = () => {};
    const spawnHeld = new Promise<void>((r) => {
      releaseSpawn = r;
    });
    const factory = buildAdapterFactory({
      claude: {
        // Block adapter.spawn() resolution until the test releases it.
        onSpawn: () => spawnHeld,
        terminal: makeResult({ summary: 'should not be reached', costUsd: 0.5 }),
        terminalDelay: 50,
      },
    });
    // Wrap the factory so we can observe the inner cancel() call on
    // the eventual AgentHandle.
    const originalFactory = factory;
    const wrappedFactory = (agent: CliAgentName) => {
      const adapter = originalFactory(agent);
      const origSpawn = adapter.spawn.bind(adapter);
      return {
        ...adapter,
        spawn: async (opts: SpawnOptions) => {
          const h = await origSpawn(opts);
          const origCancel = h.cancel.bind(h);
          return {
            ...h,
            cancel: async (reason?: string) => {
              cancelObservedByMock = true;
              return origCancel(reason);
            },
          };
        },
      };
    };
    const runner = new WorkflowRunner({ repo, adapterFactory: wrappedFactory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: ONE_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    // Give the dispatch loop a beat to enter spawn().
    await new Promise((r) => setTimeout(r, 30));
    // Cancel BEFORE spawn resolves — cancelReason lands but no handle
    // exists yet to signal. This is the race the post-assignment
    // re-check covers.
    await handle.cancel('user_toggle_off');
    // Release spawn — the runner now has a handle and must re-check.
    releaseSpawn();
    const finalRun = await handle.awaitTerminal();
    expect(finalRun.status).toBe('cancelled');
    expect(cancelObservedByMock).toBe(true);
  });

  it('treats terminalReason="budget" as failed, not done', async () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({
      claude: {
        terminal: makeResult({
          summary: 'partial work',
          costUsd: 2.0,
          terminalReason: 'budget',
        }),
      },
      codex: {
        terminal: makeResult({ summary: 'should not be reached' }),
      },
    });
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: TWO_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const finalRun = await handle.awaitTerminal();
    expect(finalRun.status).toBe('failed');
    expect(finalRun.lastError).toMatch(/budget_exhausted/);
    expect(finalRun.totalCostUsd).toBe(2.0);

    const stages = repo.listStagesForRun(finalRun.id);
    expect(stages).toHaveLength(1);
    expect(stages[0].status).toBe('failed');
    expect(stages[0].lastError).toMatch(/budget_exhausted/);
    // Cost recorded even on budget-failed stage.
    expect(stages[0].costUsd).toBe(2.0);
  });

  it('rejects schema-valid but non-linear definitions at start()', async () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult() },
    });
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    // Definition is Zod-valid but linear-violating: edge points
    // backwards. The runner boundary must catch this BEFORE creating
    // a workflow_runs row.
    const nonLinear: WorkflowDefinition = {
      schemaVersion: 1,
      name: 'reverse',
      description: '',
      stages: [
        {
          id: 'a',
          kind: 'cli_agent',
          agent: 'claude',
          promptTemplate: 'a',
          maxBudgetUsd: null,
          maxAttempts: 1,
          allowedTools: [],
        },
        {
          id: 'b',
          kind: 'cli_agent',
          agent: 'codex',
          promptTemplate: 'b',
          maxBudgetUsd: null,
          maxAttempts: 1,
          allowedTools: [],
        },
      ],
      edges: [{ from: 'b', to: 'a', on: 'success' }],
    };
    await expect(
      runner.start({
        folderId: FOLDER_ID,
        ticketId: TICKET_ID,
        definition: nonLinear,
        repoPath: REPO_PATH,
        worktreePath: WORKTREE_PATH,
        ticketContext: TICKET_CTX,
      }),
    ).rejects.toThrow(/linear array order/);
    // No row created.
    expect(repo.findActiveRunForTicket(FOLDER_ID, TICKET_ID)).toBeNull();
  });

  it('forwards an AbortSignal in SpawnOptions', async () => {
    const { repo } = setup();
    let observedSignal: AbortSignal | undefined = undefined;
    const factory = buildAdapterFactory({
      claude: {
        onSpawn: (opts) => {
          observedSignal = opts.signal;
        },
        terminal: makeResult(),
      },
    });
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const h = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: ONE_STAGE,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    await h.awaitTerminal();
    expect(observedSignal).toBeDefined();
    expect(observedSignal!.aborted).toBe(false);
  });
});

describe('WorkflowRunner — Codex T4b review regressions', () => {
  // Workflow with a stage that prefers codex but falls back to claude
  // on recoverable errors.
  const FALLBACK_WORKFLOW: WorkflowDefinition = parseLinearWorkflow({
    schemaVersion: 1,
    name: 'Fallback test',
    stages: [
      {
        id: 'review',
        kind: 'cli_agent',
        agent: 'codex',
        promptTemplate: 'review {{ticket.title}}',
        maxBudgetUsd: 1,
        maxAttempts: 1,
        allowedTools: [],
        fallbackAgent: 'claude',
      },
    ],
  });

  it('recoverable error → transparent retry with fallbackAgent (P1)', async () => {
    const { repo } = setup();
    let codexSpawned = 0;
    let claudeSpawned = 0;
    const factory = (agent: CliAgentName) => {
      if (agent === 'codex') {
        codexSpawned += 1;
        return new MockAdapter('codex', {
          terminal: makeError({
            errorKind: 'codex_ink_crash',
            message: 'Raw mode is not supported',
            recoverable: true,
          }),
        });
      }
      claudeSpawned += 1;
      return new MockAdapter('claude', {
        terminal: makeResult({ summary: 'fallback succeeded', costUsd: 0.4 }),
      });
    };
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const h = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: FALLBACK_WORKFLOW,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const final = await h.awaitTerminal();
    expect(final.status).toBe('done');
    expect(codexSpawned).toBe(1);
    expect(claudeSpawned).toBe(1);

    // Single stage row — fallback retry shares the row, doesn't
    // create a new attempt.
    const stages = repo.listStagesForRun(final.id);
    expect(stages).toHaveLength(1);
    expect(stages[0].status).toBe('done');
    expect(stages[0].agentName).toBe('claude');
    expect(stages[0].costUsd).toBe(0.4);
  });

  it('non-recoverable error → no fallback retry, stage fails immediately', async () => {
    const { repo } = setup();
    let claudeSpawned = 0;
    const factory = (agent: CliAgentName) => {
      if (agent === 'codex') {
        return new MockAdapter('codex', {
          terminal: makeError({
            errorKind: 'spawn_failed',
            message: 'binary missing',
            recoverable: false,
          }),
        });
      }
      claudeSpawned += 1;
      return new MockAdapter('claude', { terminal: makeResult() });
    };
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const h = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: FALLBACK_WORKFLOW,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const final = await h.awaitTerminal();
    expect(final.status).toBe('failed');
    expect(claudeSpawned).toBe(0);
    expect(final.lastError).toMatch(/spawn_failed/);
  });

  it('fallback also fails → stage fails (single-shot retry, no infinite loop)', async () => {
    const { repo } = setup();
    let codexSpawned = 0;
    let claudeSpawned = 0;
    const factory = (agent: CliAgentName) => {
      if (agent === 'codex') {
        codexSpawned += 1;
        return new MockAdapter('codex', {
          terminal: makeError({
            errorKind: 'codex_ink_crash',
            message: 'crash',
            recoverable: true,
          }),
        });
      }
      claudeSpawned += 1;
      return new MockAdapter('claude', {
        terminal: makeError({
          errorKind: 'codex_ink_crash',
          message: 'also recoverable but already retried',
          recoverable: true,
        }),
      });
    };
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const h = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: FALLBACK_WORKFLOW,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const final = await h.awaitTerminal();
    expect(final.status).toBe('failed');
    expect(codexSpawned).toBe(1);
    expect(claudeSpawned).toBe(1);
  });

  it('AgentBinaryNotFoundError thrown from spawn → fallbackAgent retries (P1.3)', async () => {
    const { repo } = setup();
    let claudeSpawned = 0;
    const factory = (agent: CliAgentName) => {
      if (agent === 'codex') {
        return {
          name: agent,
          async spawn() {
            const { AgentBinaryNotFoundError } = await import(
              '../src/core/auto-code/harness/adapter.js'
            );
            throw new AgentBinaryNotFoundError(agent, ['codex not on PATH']);
          },
        } as CliAgentAdapter;
      }
      claudeSpawned += 1;
      return new MockAdapter('claude', {
        terminal: makeResult({ summary: 'fallback ok', costUsd: 0.5 }),
      });
    };
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: FALLBACK_WORKFLOW,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('done');
    expect(claudeSpawned).toBe(1);
  });

  it('fenced parser walks fences in reverse (picks LATER block)', () => {
    // Reviewer included a "schema example" fenced block first, then
    // the actual verdict in a second fenced block. Earlier the
    // strategy-2 parser returned the example; now it walks reverse
    // and picks the trailing one.
    const text = [
      'Schema reminder:',
      '```json',
      '{"verdict": "reopen", "reason": "example schema"}',
      '```',
      '',
      'Actual decision:',
      '```json',
      '{"verdict": "approve", "reason": "real verdict"}',
      '```',
    ].join('\n');
    expect(parseVerdict(text)).toEqual({ verdict: 'approve', reason: 'real verdict' });
  });
});
