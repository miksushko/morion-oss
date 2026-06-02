import { describe, it, expect, beforeEach } from 'vitest';

import { openDb, type DbHandle } from '../src/core/db/client.js';
import {
  BudgetTracker,
  MoSpendLedgerRepository,
} from '../src/core/concierge/index.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '../src/core/concierge/provider.js';
import { buildProductionMoStageDispatcher } from '../src/core/auto-code/workflows/mo-stage-dispatcher-impl.js';
import type {
  MoStageDispatchInput,
} from '../src/core/auto-code/workflows/mo-stage-dispatcher.js';

/**
 * Phase 4.5 — production MoStageDispatcher integration tests.
 *
 * Pins the contract between the WorkflowRunner's mo_stage handler and
 * the dispatcher: structured `{branch, reason, costUsd}` envelope,
 * provider-unconfigured surface, parse-failure surface, modelOverride
 * passthrough.
 */

class StubProvider implements LLMProvider {
  readonly name = 'mo-stage-stub';
  readonly calls: LLMRequest[] = [];
  constructor(
    private readonly responder: (req: LLMRequest) => { content: string; costUsd?: number },
  ) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const r = this.responder(req);
    return {
      content: r.content,
      toolCalls: [],
      tokensIn: 50,
      tokensOut: 20,
      costUsd: r.costUsd ?? 0.0001,
      model: 'stub',
    };
  }
}

interface Setup {
  handle: DbHandle;
  budget: BudgetTracker;
}

function setup(): Setup {
  const handle = openDb({ path: ':memory:' });
  // mo_spend_ledger has an FK on folders(id) — insert the test
  // folder so spend recording doesn't fail with a constraint error
  // (which would surface to the dispatcher as `mo_provider_error`,
  // masking the real test signal).
  handle.db
    .prepare(`INSERT INTO folders (id, name, position, created_at) VALUES (?, ?, 0, ?)`)
    .run('fld_test', 'Test', Date.now());
  const ledger = new MoSpendLedgerRepository(handle.db);
  const budget = new BudgetTracker(ledger);
  return { handle, budget };
}

function buildInput(
  overrides: Partial<MoStageDispatchInput> = {},
): MoStageDispatchInput {
  return {
    runId: 'run_test',
    folderId: 'fld_test',
    ticketId: 'note_test',
    stage: {
      id: 'mo_after_fix',
      kind: 'mo_stage',
      isStart: false,
      instruction: 'Decide review when the fix produced a diff; reject otherwise.',
      branches: ['review', 'reject'],
      postComment: true,
      allowedTools: [],
    } as any,
    ticket: {
      id: 'note_test',
      title: 'Test ticket',
      body: 'Test body',
    },
    stageOutputs: {
      fix: { output: { summary: 'Wrote 30 lines to foo.ts, all tests pass.' } },
    },
    reopenContext: {},
    worktreePath: '/tmp/morion-test',
    ...overrides,
  } as MoStageDispatchInput;
}

describe('buildProductionMoStageDispatcher', () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });

  it("returns mo_provider_unconfigured when resolveProvider yields null", async () => {
    const dispatcher = buildProductionMoStageDispatcher({
      resolveProvider: () => null,
      resolveModel: () => 'stub-model',
      budget: s.budget,
    });
    const result = await dispatcher.decide(buildInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('mo_provider_unconfigured');
    }
  });

  it('returns mo_model_unconfigured when resolveModel yields null', async () => {
    const dispatcher = buildProductionMoStageDispatcher({
      resolveProvider: () => new StubProvider(() => ({ content: '{}' })),
      resolveModel: () => null,
      budget: s.budget,
    });
    const result = await dispatcher.decide(buildInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('mo_model_unconfigured');
    }
  });

  it("parses Mo's {branch, reason} reply and surfaces cost", async () => {
    const provider = new StubProvider(() => ({
      content: JSON.stringify({
        branch: 'review',
        reason: 'Fix wrote a non-trivial diff; sending to reviewer.',
      }),
      costUsd: 0.0025,
    }));
    const dispatcher = buildProductionMoStageDispatcher({
      resolveProvider: () => provider,
      resolveModel: () => 'cheap-tier',
      budget: s.budget,
    });
    const result = await dispatcher.decide(buildInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.branch).toBe('review');
      expect(result.reason).toContain('non-trivial diff');
      expect(result.costUsd).toBeGreaterThan(0);
    }
    // Sanity: the user-scope sent to Mo carries the legal branches +
    // the prior fix-stage output so Mo has the context to decide.
    const userMsg = provider.calls[0]!.messages.find((m) => m.role === 'user')!.content;
    expect(userMsg).toContain('review');
    expect(userMsg).toContain('reject');
    expect(userMsg).toContain('Wrote 30 lines');
  });

  it('returns mo_decision_unparseable on persistent JSON failure (post-retry)', async () => {
    const provider = new StubProvider(() => ({
      content: 'just some prose, no JSON object here',
    }));
    const dispatcher = buildProductionMoStageDispatcher({
      resolveProvider: () => provider,
      resolveModel: () => 'cheap-tier',
      budget: s.budget,
    });
    const result = await dispatcher.decide(buildInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('mo_decision_unparseable');
    }
    // runSubMoTask retries once before giving up.
    expect(provider.calls.length).toBe(2);
  });

  it('returns mo_provider_error when provider throws', async () => {
    const provider = new StubProvider(() => {
      throw new Error('rate limited');
    });
    const dispatcher = buildProductionMoStageDispatcher({
      resolveProvider: () => provider,
      resolveModel: () => 'cheap-tier',
      budget: s.budget,
    });
    const result = await dispatcher.decide(buildInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('mo_provider_error');
      expect(result.message).toContain('rate limited');
    }
  });

  it('honors modelOverride.model when useDefault is false', async () => {
    const observed: string[] = [];
    const provider = new StubProvider(() => ({
      content: JSON.stringify({ branch: 'review', reason: 'ok' }),
    }));
    const dispatcher = buildProductionMoStageDispatcher({
      resolveProvider: () => provider,
      resolveModel: (_folderId, override) => {
        observed.push(override?.model ?? 'DEFAULT');
        return override?.model ?? 'workspace-default';
      },
      budget: s.budget,
    });
    await dispatcher.decide(
      buildInput({
        stage: {
          id: 'mo_after_fix',
          kind: 'mo_stage',
          isStart: false,
          instruction: 'x',
          branches: ['review', 'reject'],
          postComment: true,
          allowedTools: [],
          modelOverride: { useDefault: false, model: 'pro-tier' },
        } as any,
      }),
    );
    expect(observed).toEqual(['pro-tier']);
  });

  it('refuses with mo_budget_exceeded when monthly cap is exhausted', async () => {
    const provider = new StubProvider(() => ({
      content: JSON.stringify({ branch: 'review', reason: 'ok' }),
    }));
    // Push the workspace into the over-cap state via direct ledger
    // write — budget.record() skips non-positive costs, and BudgetTracker
    // doesn't expose a "set cap exhausted" setter.
    const status = s.budget.status();
    s.budget.record({
      kind: 'mo_tool',
      folderId: null,
      costUsd: status.monthlyCapUsd + 0.5,
    });
    expect(s.budget.status().withinBudget).toBe(false);

    const dispatcher = buildProductionMoStageDispatcher({
      resolveProvider: () => provider,
      resolveModel: () => 'cheap-tier',
      budget: s.budget,
    });
    const result = await dispatcher.decide(buildInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('mo_budget_exceeded');
      expect(result.message).toContain('mo_after_fix');
    }
    // Provider must never have been called — the gate fires before
    // any LLM cost is incurred.
    expect(provider.calls.length).toBe(0);
  });

  it('defers to workspace default when modelOverride.useDefault is true', async () => {
    const observed: string[] = [];
    const provider = new StubProvider(() => ({
      content: JSON.stringify({ branch: 'review', reason: 'ok' }),
    }));
    const dispatcher = buildProductionMoStageDispatcher({
      resolveProvider: () => provider,
      resolveModel: (_folderId, override) => {
        observed.push(override === null ? 'DEFAULT_NULL' : 'OVERRIDE');
        return 'workspace-default';
      },
      budget: s.budget,
    });
    await dispatcher.decide(
      buildInput({
        stage: {
          id: 'mo_after_fix',
          kind: 'mo_stage',
          isStart: false,
          instruction: 'x',
          branches: ['review', 'reject'],
          postComment: true,
          allowedTools: [],
          modelOverride: { useDefault: true },
        } as any,
      }),
    );
    expect(observed).toEqual(['DEFAULT_NULL']);
  });
});
