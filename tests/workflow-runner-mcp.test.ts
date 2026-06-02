import { describe, expect, it } from 'vitest';

import {
  type BudgetGuard,
  type BudgetGuardContext,
  WorkflowRunner,
} from '../src/core/auto-code/workflows/runner.js';
import { type CliAgentName, type WorkflowDefinition } from '../src/core/auto-code/workflows/types/index.js';
import { parseLinearWorkflow } from '../src/core/auto-code/workflows/parse-linear.js';
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

describe('WorkflowRunner — Этап 4 mcp_tool_call stages', () => {
  const SUMMARISE_THEN_FIX: WorkflowDefinition = parseLinearWorkflow({
    schemaVersion: 1,
    name: 'Mo summary then fix',
    stages: [
      {
        id: 'summary',
        kind: 'mcp_tool_call',
        toolName: 'mo_ask',
        argsTemplate: {
          question: 'Summarise the ticket "{{ticket.title}}" ({{ticket.id}})',
          folderId: FOLDER_ID,
        },
      },
      {
        id: 'fix',
        kind: 'cli_agent',
        agent: 'claude',
        promptTemplate:
          'Mo says: {{stages.summary.output.data.answer}}\n\nFix the bug.',
        maxBudgetUsd: 1,
        maxAttempts: 1,
        allowedTools: [],
      },
    ],
    edges: [{ from: 'summary', to: 'fix', on: 'success' }],
  });

  it('runs mcp_tool_call stage, threads result into next cli_agent prompt', async () => {
    const { repo } = setup();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let observedPrompt = '';
    const factory = buildAdapterFactory({
      claude: {
        onSpawn: (opts) => {
          observedPrompt = opts.prompt;
        },
        terminal: makeResult({ costUsd: 0.1 }),
      },
    });
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
      mcpToolDispatcher: async (name, args) => {
        calls.push({ name, args });
        return { ok: true, data: { answer: 'Build a tetris page' } };
      },
    });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: SUMMARISE_THEN_FIX,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('mo_ask');
    // String args run through Mustache; non-string passes verbatim.
    expect(calls[0]!.args.question).toBe(
      `Summarise the ticket "Tetris" (${TICKET_ID})`,
    );
    expect(calls[0]!.args.folderId).toBe(FOLDER_ID);
    // Subsequent cli_agent stage sees the dispatched data envelope.
    expect(observedPrompt).toContain('Mo says: Build a tetris page');

    const stages = repo.listStagesForRun(final.id);
    // Order is by started_at; stages spawned in the same ms can
    // tie, so check membership + per-stage attrs by id instead of
    // by index.
    expect(stages.map((s) => s.stageIdInGraph).sort()).toEqual([
      'fix',
      'summary',
    ]);
    const summaryRow = stages.find((s) => s.stageIdInGraph === 'summary');
    const fixRow = stages.find((s) => s.stageIdInGraph === 'fix');
    expect(summaryRow?.stageKind).toBe('mcp_tool_call');
    expect(summaryRow?.status).toBe('done');
    expect(fixRow?.status).toBe('done');
  });

  it('marks run failed when mcp tool returns ok:false', async () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult({ costUsd: 0.1 }) },
    });
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
      mcpToolDispatcher: async () => ({
        ok: false,
        error: 'unknown_tool',
        message: 'no such tool',
      }),
    });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: SUMMARISE_THEN_FIX,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('failed');
    expect(final.lastError).toContain('mcp_tool_failed:unknown_tool');
    // The cli_agent stage MUST NOT have run.
    const stages = repo.listStagesForRun(final.id);
    expect(stages).toHaveLength(1);
    expect(stages[0]!.status).toBe('failed');
  });

  it('default mcpToolDispatcher (unwired) fails with mcp_tool_dispatcher_not_wired', async () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult({ costUsd: 0.1 }) },
    });
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
      // no mcpToolDispatcher injection — default kicks in.
    });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: SUMMARISE_THEN_FIX,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('failed');
    expect(final.lastError).toContain('mcp_tool_dispatcher_not_wired');
  });
});

describe('WorkflowRunner — Codex round 4 (Этап 4 follow-ups)', () => {
  const SUMMARISE_THEN_FIX: WorkflowDefinition = parseLinearWorkflow({
    schemaVersion: 1,
    name: 'Mo summary then fix',
    stages: [
      {
        id: 'summary',
        kind: 'mcp_tool_call',
        toolName: 'mo_ask',
        argsTemplate: { question: 'q' },
      },
      {
        id: 'fix',
        kind: 'cli_agent',
        agent: 'claude',
        promptTemplate: 'Mo: {{stages.summary.output.data.answer}}',
        maxBudgetUsd: 1,
        maxAttempts: 1,
        allowedTools: [],
      },
    ],
    edges: [{ from: 'summary', to: 'fix', on: 'success' }],
  });

  const SINGLE_MCP: WorkflowDefinition = parseLinearWorkflow({
    schemaVersion: 1,
    name: 'Single MCP',
    stages: [
      {
        id: 'ask',
        kind: 'mcp_tool_call',
        toolName: 'mo_ask',
        argsTemplate: { question: 'q' },
      },
    ],
  });

  it('cost rollup: dispatcher-reported costUsd lands on stage row + run total (Codex P2c)', async () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult({ costUsd: 0.5 }) },
    });
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
      mcpToolDispatcher: async () => ({
        ok: true,
        data: { answer: 'whatever' },
        costUsd: 0.07,
      }),
    });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: SUMMARISE_THEN_FIX,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('done');
    // mo_ask stage = 0.07, claude stage = 0.5, total = 0.57.
    expect(final.totalCostUsd).toBeCloseTo(0.57, 5);
    const stages = repo.listStagesForRun(final.id);
    const mcpStage = stages.find((s) => s.stageIdInGraph === 'summary');
    expect(mcpStage?.costUsd).toBeCloseTo(0.07, 5);
  });

  it('failed MCP stage fires onStageEnd before run terminates (Codex P2a)', async () => {
    const { repo } = setup();
    const stageEndCalls: string[] = [];
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult({ costUsd: 0.1 }) },
    });
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
      mcpToolDispatcher: async () => ({
        ok: false,
        error: 'unknown_tool',
        message: 'no such tool',
      }),
    });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: SUMMARISE_THEN_FIX,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
      hooks: {
        onStageEnd: ({ stageRow }) => {
          stageEndCalls.push(`${stageRow.stageIdInGraph}:${stageRow.status}`);
        },
      },
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('failed');
    // The failed MCP stage MUST surface an onStageEnd entry —
    // mirrors cli_agent failure-path lifecycle parity.
    expect(stageEndCalls).toContain('summary:failed');
  });

  it('cancel during MCP dispatcher await: stage cancelled, run cancelled (Codex P1b)', async () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult({ costUsd: 0.1 }) },
    });
    let runId: string | null = null;
    const dispatcherStarted = new Promise<void>((resolve) => {
      // resolved by dispatcher onCall
      (globalThis as { __cancelTestStarted?: () => void }).__cancelTestStarted =
        resolve;
    });
    const runner = new WorkflowRunner({
      repo,
      adapterFactory: factory,
      transcriptDir: TRANSCRIPT_DIR,
      mcpToolDispatcher: async () => {
        // Fire the latch so the test code can call cancel() before
        // we resolve. Simulates an MCP tool that takes a few ticks
        // to come back (Mo gather, network call, etc.).
        (
          globalThis as { __cancelTestStarted?: () => void }
        ).__cancelTestStarted?.();
        await new Promise((r) => setTimeout(r, 30));
        return { ok: true, data: { answer: 'late' } };
      },
    });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: SINGLE_MCP,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    runId = handle.runId;
    await dispatcherStarted;
    await handle.cancel('test_cancel');
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('cancelled');
    expect(final.lastError).toContain('test_cancel');
    const stages = repo.listStagesForRun(runId);
    expect(stages[0]!.status).toBe('cancelled');
  });

  it('reopen-loop validation rejects mcp_tool_call with too-low maxAttempts (Codex P2b)', () => {
    expect(() =>
      parseLinearWorkflow({
        schemaVersion: 1,
        name: 'Bad reopen loop with MCP stage',
        stages: [
          {
            id: 'fix',
            kind: 'cli_agent',
            agent: 'claude',
            promptTemplate: 'fix',
            maxBudgetUsd: 1,
            maxAttempts: 3,
            allowedTools: [],
          },
          {
            id: 'mid',
            kind: 'mcp_tool_call',
            toolName: 'mo_ask',
            argsTemplate: { question: 'q' },
            maxAttempts: 1, // ← too low for the reopen cap of 3 below
          },
          {
            id: 'review',
            kind: 'cli_agent',
            agent: 'codex',
            promptTemplate: 'review',
            maxBudgetUsd: 1,
            maxAttempts: 3,
            allowedTools: [],
            verdictPolicy: {
              onReopen: { reopenStageId: 'fix', maxAttempts: 3 },
              onEscalate: 'fail-run',
            },
          },
        ],
        edges: [
          { from: 'fix', to: 'mid', on: 'success' },
          { from: 'mid', to: 'review', on: 'success' },
        ],
      }),
    ).toThrow(/maxAttempts/);
  });
});
