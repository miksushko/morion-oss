import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { BudgetTracker, MoSpendLedgerRepository } from '../src/core/concierge/index.js';
import {
  buildSubMoSystemPrompt,
  runSubMoTask,
  runSubMoBatch,
  keywordGeneratorRole,
  bodyExtractorRole,
  type SubMoRole,
} from '../src/core/concierge/index.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '../src/core/concierge/provider.js';

interface ScriptedCall {
  /** Sequential 0-based index of the spawn this rule applies to.
   *  null = applies to every spawn that doesn't match a numbered rule. */
  attempt?: number;
  content: string;
  costUsd?: number;
  shouldThrow?: string;
}

class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly calls: LLMRequest[] = [];
  private readonly script: ScriptedCall[];
  private cursor = 0;

  constructor(script: ScriptedCall[]) {
    this.script = script;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const idx = this.cursor++;
    const rule =
      this.script.find((r) => r.attempt === idx) ??
      this.script.find((r) => r.attempt === undefined);
    if (!rule) throw new Error(`no script rule for spawn #${idx}`);
    if (rule.shouldThrow) throw new Error(rule.shouldThrow);
    return {
      content: rule.content,
      toolCalls: [],
      tokensIn: 100,
      tokensOut: 50,
      costUsd: rule.costUsd ?? 0.0001,
      model: 'scripted',
    };
  }
}

function makeBudget(): { db: DbHandle; budget: BudgetTracker } {
  const handle = openDb({ path: ':memory:' });
  const ledger = new MoSpendLedgerRepository(handle.db);
  return { db: handle, budget: new BudgetTracker(ledger) };
}

// ---------------------------------------------------------------------
// Prompt template assembly
// ---------------------------------------------------------------------

describe('buildSubMoSystemPrompt — canonical template', () => {
  it('contains role name, purpose, hard rules, and schema description', () => {
    const prompt = buildSubMoSystemPrompt(keywordGeneratorRole);
    expect(prompt).toContain('keyword-generator');
    expect(prompt).toContain('search keywords');
    expect(prompt).toContain('HARD RULES');
    expect(prompt).toContain('You have NO tools');
    expect(prompt).toContain('OUTPUT SCHEMA');
    expect(prompt).toContain('"keywords"');
  });

  it('appends extraRules when present', () => {
    const prompt = buildSubMoSystemPrompt(keywordGeneratorRole);
    expect(prompt).toContain('between 4 and 12 keywords');
  });

  it('omits extraRules block when absent', () => {
    const role: SubMoRole<{ x: number }> = {
      name: 'demo',
      purpose: 'Test role with no extra rules.',
      schema: z.object({ x: z.number() }),
      schemaDescription: '{ "x": number }',
    };
    const prompt = buildSubMoSystemPrompt(role);
    expect(prompt).toContain('demo');
    expect(prompt).toContain('Test role with no extra rules.');
    // Should NOT include any "extra" markers.
    expect(prompt.split('OUTPUT SCHEMA')[0]).not.toContain('between 4 and 12');
  });
});

// ---------------------------------------------------------------------
// runSubMoTask — happy path + retry + provider error
// ---------------------------------------------------------------------

describe('runSubMoTask', () => {
  let host: { db: DbHandle; budget: BudgetTracker };
  beforeEach(() => {
    host = makeBudget();
  });

  it('returns ok+data when JSON parses and Zod validates on first attempt', async () => {
    const provider = new ScriptedProvider([
      { content: '{"keywords":["stripe","webhook","idempotency","event-id"]}' },
    ]);
    const result = await runSubMoTask(
      { provider, model: 'stub', budget: host.budget },
      keywordGeneratorRole,
      'Implement Stripe webhook idempotency.',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.keywords).toEqual(['stripe', 'webhook', 'idempotency', 'event-id']);
    expect(result.retried).toBe(false);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(provider.calls).toHaveLength(1);
  });

  it('strips markdown fences before parsing', async () => {
    const provider = new ScriptedProvider([
      {
        content:
          '```json\n{"keywords":["stripe","webhook"]}\n```',
      },
    ]);
    const result = await runSubMoTask(
      { provider, model: 'stub', budget: host.budget },
      keywordGeneratorRole,
      'Stripe',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.data.keywords).toEqual(['stripe', 'webhook']);
  });

  it('extracts JSON object embedded in prose', async () => {
    const provider = new ScriptedProvider([
      {
        content:
          'Sure! Here is the JSON: {"keywords":["a","b","c","d"]} hope this helps',
      },
    ]);
    const result = await runSubMoTask(
      { provider, model: 'stub', budget: host.budget },
      keywordGeneratorRole,
      'x',
    );
    expect(result.ok).toBe(true);
  });

  it('retries once on invalid JSON, succeeds on second attempt', async () => {
    const provider = new ScriptedProvider([
      { attempt: 0, content: 'I refuse to emit JSON, here is a paragraph instead.' },
      { attempt: 1, content: '{"keywords":["recovered","after","retry"]}' },
    ]);
    const result = await runSubMoTask(
      { provider, model: 'stub', budget: host.budget },
      keywordGeneratorRole,
      'x',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.retried).toBe(true);
    expect(result.data.keywords).toEqual(['recovered', 'after', 'retry']);
    expect(provider.calls).toHaveLength(2);
    // Retry prompt MUST contain the explicit reminder.
    expect(provider.calls[1]!.messages[1]!.content).toContain(
      'could not be parsed as JSON',
    );
  });

  it('returns ok+failure (invalid_json) after both attempts produce garbage', async () => {
    const provider = new ScriptedProvider([
      { content: 'still no JSON' },
    ]);
    const result = await runSubMoTask(
      { provider, model: 'stub', budget: host.budget },
      keywordGeneratorRole,
      'x',
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('invalid_json');
    expect(result.raw).toContain('still no JSON');
    expect(result.costUsd).toBeGreaterThan(0); // both attempts billed
    expect(provider.calls).toHaveLength(2);
  });

  it('returns ok+failure (schema_mismatch) when JSON parses but fails Zod', async () => {
    const provider = new ScriptedProvider([
      { content: '{"keywords":"not-an-array"}' },
    ]);
    const result = await runSubMoTask(
      { provider, model: 'stub', budget: host.budget },
      keywordGeneratorRole,
      'x',
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('schema_mismatch');
    expect(result.errorMessage).toContain('keywords');
  });

  it('returns provider_error and short-circuits without retrying when provider throws', async () => {
    const provider = new ScriptedProvider([
      { shouldThrow: 'connection refused', content: '' },
    ]);
    const result = await runSubMoTask(
      { provider, model: 'stub', budget: host.budget },
      keywordGeneratorRole,
      'x',
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('provider_error');
    expect(result.errorMessage).toBe('connection refused');
    // Provider threw on attempt 0 → no retry, no second call.
    expect(provider.calls).toHaveLength(1);
  });

  it('records spend per spawn against the budget tracker', async () => {
    const provider = new ScriptedProvider([
      { content: '{"keywords":["a","b","c","d"]}', costUsd: 0.005 },
    ]);
    await runSubMoTask(
      { provider, model: 'stub', budget: host.budget },
      keywordGeneratorRole,
      'x',
    );
    const status = host.budget.status();
    expect(status.spentMonthUsd).toBeCloseTo(0.005, 5);
  });
});

// ---------------------------------------------------------------------
// runSubMoBatch — best-effort partial results
// ---------------------------------------------------------------------

describe('runSubMoBatch — best-effort semantics', () => {
  let host: { db: DbHandle; budget: BudgetTracker };
  beforeEach(() => {
    host = makeBudget();
  });

  it('preserves input order and continues despite individual failures', async () => {
    // 3 scopes; spawn 0 ok, spawn 1 garbage (will retry → still garbage),
    // spawn 2 ok. Batch concurrency is 2 so the order in which
    // spawn-attempts hit the provider isn't fixed — script by content
    // shape, not by index.
    let callIdx = 0;
    const provider = new (class implements LLMProvider {
      readonly name = 'scripted-batch';
      readonly calls: LLMRequest[] = [];
      async complete(req: LLMRequest): Promise<LLMResponse> {
        this.calls.push(req);
        const userMsg = req.messages[1]!.content;
        const myCallIdx = callIdx++;
        if (userMsg.includes('SCOPE-A')) {
          return resp(
            '{"chunks":["chunk-A"],"why":"matters for A","isWarning":false}',
            myCallIdx,
          );
        }
        if (userMsg.includes('SCOPE-B')) {
          // Always emit garbage — both attempts → schema_mismatch.
          return resp('not JSON for B', myCallIdx);
        }
        if (userMsg.includes('SCOPE-C')) {
          return resp(
            '{"chunks":["chunk-C"],"why":"matters for C","isWarning":true}',
            myCallIdx,
          );
        }
        return resp('{"chunks":[],"why":"","isWarning":false}', myCallIdx);
      }
    })();
    function resp(content: string, _idx: number): LLMResponse {
      return {
        content,
        toolCalls: [],
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.0001,
        model: 'scripted-batch',
      };
    }

    const summary = await runSubMoBatch(
      { provider, model: 'stub', budget: host.budget },
      bodyExtractorRole,
      [
        { scope: 'SCOPE-A: a body relevant to question.' },
        { scope: 'SCOPE-B: a body that triggers garbage output.' },
        { scope: 'SCOPE-C: a body relevant with warning.' },
      ],
      { concurrency: 2 },
    );

    expect(summary.results).toHaveLength(3);
    expect(summary.results[0]?.ok).toBe(true);
    expect(summary.results[1]?.ok).toBe(false);
    expect(summary.results[2]?.ok).toBe(true);

    if (summary.results[0]?.ok) {
      expect(summary.results[0].data.chunks).toEqual(['chunk-A']);
    }
    if (summary.results[2]?.ok) {
      expect(summary.results[2].data.isWarning).toBe(true);
    }

    expect(summary.okCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.totalCostUsd).toBeGreaterThan(0);
  });

  it('marks failureRateExceeded when more than half of spawns fail', async () => {
    const provider = new ScriptedProvider([{ content: 'never JSON' }]);
    const summary = await runSubMoBatch(
      { provider, model: 'stub', budget: host.budget },
      keywordGeneratorRole,
      [
        { scope: 's1' },
        { scope: 's2' },
        { scope: 's3' },
      ],
      { failureWarnAt: 0.5 },
    );
    expect(summary.failedCount).toBe(3);
    expect(summary.failureRateExceeded).toBe(true);
  });

  it('returns empty summary on empty input set', async () => {
    const provider = new ScriptedProvider([{ content: '{}' }]);
    const summary = await runSubMoBatch(
      { provider, model: 'stub', budget: host.budget },
      keywordGeneratorRole,
      [],
    );
    expect(summary.results).toHaveLength(0);
    expect(summary.okCount).toBe(0);
    expect(summary.failedCount).toBe(0);
    expect(summary.failureRateExceeded).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// Role definitions — sanity check that schemas accept canonical shapes
// ---------------------------------------------------------------------

describe('role schemas — accept canonical shapes', () => {
  it('keywordGeneratorRole.schema accepts keyword arrays', () => {
    const ok = keywordGeneratorRole.schema.safeParse({
      keywords: ['stripe', 'webhook', 'idempotency'],
    });
    expect(ok.success).toBe(true);
  });

  it('keywordGeneratorRole.schema accepts empty keyword array', () => {
    const ok = keywordGeneratorRole.schema.safeParse({ keywords: [] });
    expect(ok.success).toBe(true);
  });

  it('keywordGeneratorRole.schema rejects missing keywords field', () => {
    const fail = keywordGeneratorRole.schema.safeParse({});
    expect(fail.success).toBe(false);
  });

  it('bodyExtractorRole.schema accepts canonical shape', () => {
    const ok = bodyExtractorRole.schema.safeParse({
      chunks: ['quote one', 'quote two'],
      why: 'because the agent is implementing the same thing',
      isWarning: false,
    });
    expect(ok.success).toBe(true);
  });

  it('bodyExtractorRole.schema rejects missing isWarning', () => {
    const fail = bodyExtractorRole.schema.safeParse({
      chunks: [],
      why: '',
    });
    expect(fail.success).toBe(false);
  });
});
