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

describe('WorkflowRunner — T4b verdict-policy reopen loop', () => {
  // Workflow: fix (claude) → review (codex with verdictPolicy
  // reopening 'fix' up to 3 times). The MockAdapter for the review
  // stage returns a controlled verdict via terminal.summary; the
  // fix-stage mock is reusable across iterations.
  const REOPEN_WORKFLOW: WorkflowDefinition = parseLinearWorkflow({
    schemaVersion: 1,
    name: 'Default Autocode replica',
    stages: [
      {
        id: 'fix',
        kind: 'cli_agent',
        agent: 'claude',
        promptTemplate:
          'Fix {{ticket.title}}\n\n{{reopen.reason}}',
        maxBudgetUsd: 2,
        maxAttempts: 3,
        allowedTools: [],
      },
      {
        id: 'review',
        kind: 'cli_agent',
        agent: 'codex',
        promptTemplate: 'Review {{stages.fix.output.summary}}',
        maxBudgetUsd: 1,
        maxAttempts: 3,
        allowedTools: [],
        verdictPolicy: {
          onReopen: { reopenStageId: 'fix', maxAttempts: 3 },
          onEscalate: 'fail-run',
        },
      },
    ],
    edges: [{ from: 'fix', to: 'review', on: 'success' }],
  });

  function buildVerdictStream(verdicts: Array<'approve' | 'reopen' | 'escalate'>) {
    let i = 0;
    return () => {
      const v = verdicts[i++ % verdicts.length];
      return makeResult({
        summary: JSON.stringify({ verdict: v, reason: `verdict-${i}` }),
        costUsd: 0.05,
      });
    };
  }

  it('approve verdict completes the run after one fix+review cycle', async () => {
    const { repo } = setup();
    const fixCalls: string[] = [];
    const factory = buildAdapterFactory({
      claude: {
        onSpawn: (opts) => fixCalls.push(opts.prompt),
        terminal: makeResult({ summary: 'fix iteration', costUsd: 0.3 }),
      },
      codex: {
        terminal: makeResult({
          summary: '{"verdict":"approve","reason":"LGTM"}',
          costUsd: 0.05,
        }),
      },
    });
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: REOPEN_WORKFLOW,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('done');
    expect(fixCalls).toHaveLength(1);
    // First fix call has no reopen context → empty reason placeholder.
    expect(fixCalls[0]).not.toMatch(/Previous reviewer feedback/);
  });

  it('reopen verdict re-runs fix with reviewer reason injected', async () => {
    const { repo } = setup();
    const fixPrompts: string[] = [];
    let fixCallCount = 0;
    let reviewCallCount = 0;
    const factory = (agent: CliAgentName) => {
      if (agent === 'claude') {
        return new MockAdapter('claude', {
          onSpawn: (opts) => {
            fixPrompts.push(opts.prompt);
            fixCallCount += 1;
          },
          terminal: makeResult({ summary: `fix run ${fixCallCount + 1}`, costUsd: 0.3 }),
        });
      }
      // Reviewer says reopen the first time, approve the second.
      const summary =
        reviewCallCount === 0
          ? '{"verdict":"reopen","reason":"missing tests for null path"}'
          : '{"verdict":"approve","reason":"good now"}';
      reviewCallCount += 1;
      return new MockAdapter('codex', {
        terminal: makeResult({ summary, costUsd: 0.05 }),
      });
    };
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: REOPEN_WORKFLOW,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('done');
    expect(fixCallCount).toBe(2);
    // Second fix call MUST include the reviewer feedback block.
    expect(fixPrompts[0]).not.toMatch(/Previous reviewer feedback/);
    expect(fixPrompts[1]).toMatch(/Previous reviewer feedback/);
    expect(fixPrompts[1]).toMatch(/missing tests for null path/);

    // Stage rows: 2× fix (attempt 1+2), 2× review.
    const stages = repo.listStagesForRun(final.id);
    const fixStages = stages.filter((s) => s.stageIdInGraph === 'fix');
    const reviewStages = stages.filter((s) => s.stageIdInGraph === 'review');
    expect(fixStages.map((s) => s.attempt).sort()).toEqual([1, 2]);
    expect(reviewStages).toHaveLength(2);
  });

  it('reopen cap exhausted → run failed with reopen_cap_exhausted', async () => {
    const { repo } = setup();
    let fixCalls = 0;
    const factory = (agent: CliAgentName) => {
      if (agent === 'claude') {
        return new MockAdapter('claude', {
          onSpawn: () => {
            fixCalls += 1;
          },
          terminal: makeResult({ summary: 'fix', costUsd: 0.1 }),
        });
      }
      // Always reopen — should exhaust the cap.
      return new MockAdapter('codex', {
        terminal: makeResult({
          summary: '{"verdict":"reopen","reason":"still wrong"}',
          costUsd: 0.05,
        }),
      });
    };
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: REOPEN_WORKFLOW,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('failed');
    expect(final.lastError).toMatch(/reopen_cap_exhausted/);
    // maxAttempts: 3 → 3 fix calls, 3 reviews; the 3rd review's
    // reopen verdict trips the cap.
    expect(fixCalls).toBe(3);
  });

  it('escalate verdict → run failed with escalated_by_review + reason', async () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult({ summary: 'fix', costUsd: 0.1 }) },
      codex: {
        terminal: makeResult({
          summary: '{"verdict":"escalate","reason":"ticket spec is ambiguous"}',
          costUsd: 0.05,
        }),
      },
    });
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: REOPEN_WORKFLOW,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('failed');
    expect(final.lastError).toMatch(/escalated_by_review/);
    expect(final.lastError).toMatch(/ambiguous/);
  });

  it('unparseable reviewer summary → escalates (parser fallback)', async () => {
    const { repo } = setup();
    const factory = buildAdapterFactory({
      claude: { terminal: makeResult({ summary: 'fix', costUsd: 0.1 }) },
      codex: {
        terminal: makeResult({
          // No JSON envelope — the parser falls back to escalate.
          summary: 'I have absolutely no idea what to do here.',
          costUsd: 0.05,
        }),
      },
    });
    const runner = new WorkflowRunner({ repo, adapterFactory: factory, transcriptDir: TRANSCRIPT_DIR });
    const handle = await runner.start({
      folderId: FOLDER_ID,
      ticketId: TICKET_ID,
      definition: REOPEN_WORKFLOW,
      repoPath: REPO_PATH,
      worktreePath: WORKTREE_PATH,
      ticketContext: TICKET_CTX,
    });
    const final = await handle.awaitTerminal();
    expect(final.status).toBe('failed');
    expect(final.lastError).toMatch(/escalated_by_review/);
    expect(final.lastError).toMatch(/unparseable output/);
  });

  it('reopen target stage id unknown → schema rejects at parseLinearWorkflow', () => {
    // The Codex P2 finding: validate verdictPolicy targets at parse
    // time. A definition with an unknown reopenStageId no longer
    // reaches the runner.
    expect(() =>
      parseLinearWorkflow({
        schemaVersion: 1,
        name: 'Broken policy',
        stages: [
          {
            id: 'fix',
            kind: 'cli_agent',
            agent: 'claude',
            promptTemplate: 'fix',
          },
          {
            id: 'review',
            kind: 'cli_agent',
            agent: 'codex',
            promptTemplate: 'review',
            verdictPolicy: {
              onReopen: { reopenStageId: 'nonexistent', maxAttempts: 3 },
              onEscalate: 'fail-run',
            },
          },
        ],
        edges: [{ from: 'fix', to: 'review', on: 'success' }],
      }),
    ).toThrow(/reopenStageId.*does not match any stage/);
  });
});

describe('WorkflowDefinitionSchema — verdictPolicy refinements (P2)', () => {
  it('rejects forward / same-stage reopen targets', () => {
    expect(() =>
      parseLinearWorkflow({
        schemaVersion: 1,
        name: 'Forward target',
        stages: [
          {
            id: 'fix',
            kind: 'cli_agent',
            agent: 'claude',
            promptTemplate: 'a',
            verdictPolicy: {
              onReopen: { reopenStageId: 'review', maxAttempts: 3 },
              onEscalate: 'fail-run',
            },
          },
          {
            id: 'review',
            kind: 'cli_agent',
            agent: 'codex',
            promptTemplate: 'b',
          },
        ],
        edges: [{ from: 'fix', to: 'review', on: 'success' }],
      }),
    ).toThrow(/EARLIER stage/);
  });

  it('rejects misaligned maxAttempts (policy > target)', () => {
    expect(() =>
      parseLinearWorkflow({
        schemaVersion: 1,
        name: 'Misaligned',
        stages: [
          {
            id: 'fix',
            kind: 'cli_agent',
            agent: 'claude',
            promptTemplate: 'a',
            maxAttempts: 2,
          },
          {
            id: 'review',
            kind: 'cli_agent',
            agent: 'codex',
            promptTemplate: 'b',
            verdictPolicy: {
              onReopen: { reopenStageId: 'fix', maxAttempts: 5 },
              onEscalate: 'fail-run',
            },
          },
        ],
      }),
    ).toThrow(/exceeds stage.*maxAttempts/);
  });
});
