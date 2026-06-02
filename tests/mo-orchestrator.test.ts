import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/core/db/client.js';
import {
  BudgetTracker,
  MoSpendLedgerRepository,
  spawnSubMo,
  spawnSubMoBatch,
  requireBudget,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type MoOrchestratorDeps,
  type SpawnSubMoInput,
} from '../src/core/concierge/index.js';

function freshDb(): Database.Database {
  const { db } = openDb({ path: ':memory:' });
  db.prepare(
    `INSERT INTO folders (id, name, position, created_at) VALUES (?, ?, 0, ?)`,
  ).run('fld_1', 'Test', Date.now());
  return db;
}

class StubProvider implements LLMProvider {
  readonly name = 'stub';
  calls: LLMRequest[] = [];
  responses: Array<Partial<LLMResponse>> = [];
  responseFor: ((req: LLMRequest) => Partial<LLMResponse>) | null = null;
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const base = this.responseFor ? this.responseFor(req) : this.responses.shift() ?? {};
    return {
      content: 'stub',
      toolCalls: [],
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.001,
      model: req.model,
      ...base,
    };
  }
}

interface Ctx {
  db: Database.Database;
  ledger: MoSpendLedgerRepository;
  budget: BudgetTracker;
  provider: StubProvider;
  deps: MoOrchestratorDeps;
}

function setup(): Ctx {
  const db = freshDb();
  const ledger = new MoSpendLedgerRepository(db);
  const budget = new BudgetTracker(ledger);
  const provider = new StubProvider();
  const deps: MoOrchestratorDeps = {
    provider,
    model: 'cheap-test-model',
    fallbackModel: null,
    budget,
  };
  return { db, ledger, budget, provider, deps };
}

describe('spawnSubMo', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('makes one provider call and records cost to ledger as mo_tool', async () => {
    ctx.provider.responses = [{ content: 'extracted chunk', costUsd: 0.0042 }];
    const r = await spawnSubMo(ctx.deps, {
      systemPrompt: 'you extract chunks',
      userPrompt: 'note body + question',
      folderId: 'fld_1',
    });
    expect(r.content).toBe('extracted chunk');
    expect(r.costUsd).toBeCloseTo(0.0042, 5);
    expect(ctx.provider.calls).toHaveLength(1);
    expect(ctx.provider.calls[0].messages[0].role).toBe('system');
    expect(ctx.provider.calls[0].messages[1].role).toBe('user');
    expect(ctx.budget.status().spentMonthBreakdown.mo_tool).toBeCloseTo(0.0042, 5);
    expect(ctx.budget.status().spentMonthBreakdown.chat).toBe(0);
  });

  it('temperature defaults to 0.2 (extractor mode)', async () => {
    await spawnSubMo(ctx.deps, { systemPrompt: 's', userPrompt: 'u' });
    expect(ctx.provider.calls[0].temperature).toBe(0.2);
  });

  it('temperature override is respected (synthesis can pass higher)', async () => {
    await spawnSubMo(ctx.deps, { systemPrompt: 's', userPrompt: 'u', temperature: 0.6 });
    expect(ctx.provider.calls[0].temperature).toBe(0.6);
  });

  it('zero-cost calls (Groq free tier) do NOT bloat the ledger', async () => {
    ctx.provider.responses = [{ content: 'x', costUsd: 0 }];
    await spawnSubMo(ctx.deps, { systemPrompt: 's', userPrompt: 'u' });
    expect(ctx.budget.status().spentMonthBreakdown.mo_tool).toBe(0);
  });
});

describe('spawnSubMoBatch', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('preserves input order in results (NOT completion order)', async () => {
    // Make later calls resolve faster so completion order != input order.
    let counter = 0;
    ctx.provider.responseFor = (req) => {
      const idx = counter++;
      const delay = (10 - idx) * 5;
      return {
        content: `chunk ${(req.messages[1] as { content: string }).content}`,
        costUsd: 0.001,
      } as Partial<LLMResponse> & { _delay?: number; _delayPromise?: Promise<void> };
    };
    const inputs: SpawnSubMoInput[] = ['a', 'b', 'c', 'd'].map((tag) => ({
      systemPrompt: 's',
      userPrompt: tag,
    }));
    const results = await spawnSubMoBatch(ctx.deps, inputs);
    expect(results.map((r) => r.content)).toEqual(['chunk a', 'chunk b', 'chunk c', 'chunk d']);
  });

  it('records one ledger row per call regardless of concurrency', async () => {
    const inputs: SpawnSubMoInput[] = Array.from({ length: 7 }, (_, i) => ({
      systemPrompt: 's',
      userPrompt: `q${i}`,
    }));
    ctx.provider.responseFor = () => ({ costUsd: 0.001 });
    await spawnSubMoBatch(ctx.deps, inputs, { concurrency: 3 });
    expect(ctx.ledger.recent(20)).toHaveLength(7);
    expect(ctx.budget.status().spentMonthBreakdown.mo_tool).toBeCloseTo(0.007, 5);
  });

  it('empty input returns empty array without calling provider', async () => {
    const r = await spawnSubMoBatch(ctx.deps, []);
    expect(r).toEqual([]);
    expect(ctx.provider.calls).toHaveLength(0);
  });

  it('rejection bubbles (caller decides how to recover)', async () => {
    let i = 0;
    ctx.provider.complete = async () => {
      i++;
      if (i === 2) throw new Error('upstream timeout');
      return {
        content: 'ok',
        toolCalls: [],
        tokensIn: 10,
        tokensOut: 5,
        costUsd: 0.001,
        model: 'm',
      };
    };
    await expect(
      spawnSubMoBatch(ctx.deps, [
        { systemPrompt: 's', userPrompt: 'a' },
        { systemPrompt: 's', userPrompt: 'b' },
        { systemPrompt: 's', userPrompt: 'c' },
      ]),
    ).rejects.toThrow(/timeout/);
  });
});

describe('requireBudget', () => {
  it('returns null when within budget', () => {
    const { budget } = setup();
    expect(requireBudget(budget)).toBeNull();
  });

  it('returns mo_budget_exceeded denial when over cap', () => {
    const { ledger, budget } = setup();
    ledger.record({ kind: 'mo_tool', costUsd: 11 });
    const denial = requireBudget(budget);
    expect(denial).toMatchObject({
      error: 'mo_budget_exceeded',
      reason: 'monthly_cap_reached',
    });
  });
});
