import { describe, it, expect } from 'vitest';
import { routeVerdict } from '../src/core/auto-code/workflows/route-verdict.js';
import type { WorkflowStage } from '../src/core/auto-code/workflows/types/index.js';
import type { WorkflowRunsRepository } from '../src/core/auto-code/workflows/runs-repository.js';

const mkStage = (
  id: string,
  over: Partial<Extract<WorkflowStage, { kind: 'cli_agent' }>> = {},
): Extract<WorkflowStage, { kind: 'cli_agent' }> => ({
  id,
  kind: 'cli_agent',
  agent: 'claude',
  provider: null,
  model: null,
  level: null,
  agentInstruction: '',
  promptTemplate: '',
  maxBudgetUsd: null,
  maxAttempts: 1,
  allowedTools: [],
  fallbackProvider: null,
  fallbackModel: null,
  fallbackLevel: null,
  fallbackAgentInstruction: '',
  ...over,
});

function fakeRepo(
  attempts: Record<string, number> = {},
): Pick<WorkflowRunsRepository, 'latestAttemptForStage'> {
  return {
    latestAttemptForStage(_runId: string, stageId: string) {
      const n = attempts[stageId];
      if (n === undefined) return null;
      return {
        id: 'fake',
        runId: _runId,
        stageId,
        attempt: n,
        agent: 'claude',
        status: 'done',
        startedAt: 0,
        finishedAt: 1,
        activePid: null,
        sessionId: null,
        costUsd: 0,
        promptTokens: null,
        completionTokens: null,
        lastError: null,
        output: null,
      } as any;
    },
  };
}

describe('routeVerdict', () => {
  const stages: WorkflowStage[] = [
    mkStage('fix'),
    mkStage('review', {
      verdictPolicy: {
        onReopen: { reopenStageId: 'fix', maxAttempts: 3 },
        onEscalate: 'fail-run',
      },
    }),
  ];

  it("returns kind='approve' for the approve verdict", () => {
    const repo = fakeRepo() as WorkflowRunsRepository;
    const decision = routeVerdict('approve', stages[1] as any, stages, { runId: 'r1', repo });
    expect(decision).toEqual({ kind: 'approve' });
  });

  it("returns kind='escalate' for the escalate verdict", () => {
    const repo = fakeRepo() as WorkflowRunsRepository;
    const decision = routeVerdict('escalate', stages[1] as any, stages, { runId: 'r1', repo });
    expect(decision).toEqual({ kind: 'escalate' });
  });

  it('returns kind=misconfigured when reopen is asked with no onReopen policy', () => {
    const review = mkStage('review', {
      verdictPolicy: { onEscalate: 'fail-run' },
    });
    const repo = fakeRepo() as WorkflowRunsRepository;
    const decision = routeVerdict('reopen', review, [mkStage('fix'), review], { runId: 'r1', repo });
    expect(decision.kind).toBe('misconfigured');
    if (decision.kind !== 'misconfigured') throw new Error('unreachable');
    expect(decision.reason).toMatch(/onReopen is unset/);
  });

  it('returns kind=misconfigured when reopen target is not in stages', () => {
    const review = mkStage('review', {
      verdictPolicy: {
        onReopen: { reopenStageId: 'nonexistent', maxAttempts: 3 },
        onEscalate: 'fail-run',
      },
    });
    const repo = fakeRepo() as WorkflowRunsRepository;
    const decision = routeVerdict('reopen', review, [mkStage('fix'), review], { runId: 'r1', repo });
    expect(decision.kind).toBe('misconfigured');
    if (decision.kind !== 'misconfigured') throw new Error('unreachable');
    expect(decision.reason).toMatch(/nonexistent/);
  });

  it("returns kind='reopen' with targetIndex when attempts below cap", () => {
    const repo = fakeRepo({ fix: 1 }) as WorkflowRunsRepository;
    const decision = routeVerdict('reopen', stages[1] as any, stages, { runId: 'r1', repo });
    expect(decision).toEqual({ kind: 'reopen', targetIndex: 0 });
  });

  it('routes to the first matching reopen target index', () => {
    const stagesWithExtras: WorkflowStage[] = [
      mkStage('alpha'),
      mkStage('fix'),
      mkStage('review', {
        verdictPolicy: {
          onReopen: { reopenStageId: 'fix', maxAttempts: 3 },
          onEscalate: 'fail-run',
        },
      }),
    ];
    const repo = fakeRepo({ fix: 0 }) as WorkflowRunsRepository;
    const decision = routeVerdict('reopen', stagesWithExtras[2] as any, stagesWithExtras, { runId: 'r1', repo });
    expect(decision).toEqual({ kind: 'reopen', targetIndex: 1 });
  });

  it('returns kind=reopen_cap_exhausted when attempts >= cap', () => {
    const repo = fakeRepo({ fix: 3 }) as WorkflowRunsRepository;
    const decision = routeVerdict('reopen', stages[1] as any, stages, { runId: 'r1', repo });
    expect(decision.kind).toBe('reopen_cap_exhausted');
    if (decision.kind !== 'reopen_cap_exhausted') throw new Error('unreachable');
    expect(decision.attempts).toBe(3);
    expect(decision.cap).toBe(3);
    expect(decision.reopenStageId).toBe('fix');
  });

  it('treats no prior attempt as 0 attempts', () => {
    // Cap=2, no prior attempt → 0 < 2 → reopen permitted
    const review = mkStage('review', {
      verdictPolicy: {
        onReopen: { reopenStageId: 'fix', maxAttempts: 2 },
        onEscalate: 'fail-run',
      },
    });
    const repo = fakeRepo() as WorkflowRunsRepository;
    const decision = routeVerdict('reopen', review, [mkStage('fix'), review], { runId: 'r1', repo });
    expect(decision.kind).toBe('reopen');
  });
});
