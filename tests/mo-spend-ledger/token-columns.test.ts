import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  MoSpendLedgerRepository,
  spendInputFromLLMResponse,
} from '../../src/core/concierge/index.js';
import { freshDb } from '../helpers/mo-spend-ledger-setup.js';

describe('MoSpendLedger — token columns (migration 0036, ticket 01KRJSTN74FT7VRX6KAA42GGBS)', () => {
  let db: Database.Database;
  let ledger: MoSpendLedgerRepository;

  beforeEach(() => {
    db = freshDb();
    ledger = new MoSpendLedgerRepository(db);
  });

  it('persists provider/model/tokens when passed to record()', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    ledger.record(
      {
        kind: 'chat',
        costUsd: 0.0042,
        provider: 'openrouter',
        model: 'x-ai/grok-4.1-fast',
        promptTokens: 1200,
        completionTokens: 350,
        cachedTokens: 800,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      now,
    );
    const rows = ledger.recent(1);
    expect(rows[0].provider).toBe('openrouter');
    expect(rows[0].model).toBe('x-ai/grok-4.1-fast');
    expect(rows[0].promptTokens).toBe(1200);
    expect(rows[0].completionTokens).toBe(350);
    expect(rows[0].cachedTokens).toBe(800);
    expect(rows[0].cacheWriteTokens).toBe(0);
    expect(rows[0].reasoningTokens).toBe(0);
  });

  it('leaves token / provider / model columns NULL when caller omits them (back-compat)', () => {
    // Slice-1 invariant: pre-Slice-4 callsites that pass only the
    // base fields keep compiling and produce rows with NULL token
    // columns. The aggregator (Slice 5) distinguishes NULL ("not
    // captured") from 0 ("captured + zero").
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    ledger.record({ kind: 'mo_tool', costUsd: 0.001 }, now);
    const rows = ledger.recent(1);
    expect(rows[0].provider).toBeNull();
    expect(rows[0].model).toBeNull();
    expect(rows[0].promptTokens).toBeNull();
    expect(rows[0].completionTokens).toBeNull();
    expect(rows[0].cachedTokens).toBeNull();
    expect(rows[0].cacheWriteTokens).toBeNull();
    expect(rows[0].reasoningTokens).toBeNull();
  });

  it('migration 0037 accepts the five narrow Mo kinds at the CHECK layer', () => {
    expect(() =>
      ledger.record({ kind: 'mo_indexing_tier1', folderId: 'fld_1', costUsd: 0.001 }),
    ).not.toThrow();
    expect(() =>
      ledger.record({ kind: 'mo_indexing_tier2', folderId: 'fld_1', costUsd: 0.002 }),
    ).not.toThrow();
    expect(() =>
      ledger.record({ kind: 'mo_indexing_catalog', folderId: 'fld_1', costUsd: 0.003 }),
    ).not.toThrow();
    expect(() =>
      ledger.record({ kind: 'mo_topic_hygiene', folderId: 'fld_1', costUsd: 0.004 }),
    ).not.toThrow();
    expect(() =>
      ledger.record({ kind: 'mo_gather', folderId: 'fld_1', costUsd: 0.005 }),
    ).not.toThrow();
  });

  it('monthlyBreakdown reflects the narrow kinds as their own keys', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    ledger.record({ kind: 'mo_indexing_tier1', folderId: 'fld_1', costUsd: 0.10 }, now);
    ledger.record({ kind: 'mo_indexing_tier2', folderId: 'fld_1', costUsd: 0.20 }, now);
    ledger.record({ kind: 'mo_indexing_catalog', folderId: 'fld_1', costUsd: 0.30 }, now);
    ledger.record({ kind: 'mo_topic_hygiene', folderId: 'fld_1', costUsd: 0.05 }, now);
    ledger.record({ kind: 'mo_gather', folderId: 'fld_1', costUsd: 0.15 }, now);
    // Legacy mo_tool rows survive — mo_record / mo_remember / auto-code
    // workflow Mo decisions still write to this bucket.
    ledger.record({ kind: 'mo_tool', folderId: 'fld_1', costUsd: 0.07 }, now);
    const b = ledger.monthlyBreakdown(now);
    expect(b.mo_indexing_tier1).toBeCloseTo(0.10, 3);
    expect(b.mo_indexing_tier2).toBeCloseTo(0.20, 3);
    expect(b.mo_indexing_catalog).toBeCloseTo(0.30, 3);
    expect(b.mo_topic_hygiene).toBeCloseTo(0.05, 3);
    expect(b.mo_gather).toBeCloseTo(0.15, 3);
    expect(b.mo_tool).toBeCloseTo(0.07, 3);
  });

  it('spendInputFromLLMResponse maps every LLMResponse field into RecordSpendInput (slice 4 plumb)', () => {
    // Pins the helper used by tier1 / tier2 / tier25 / topic-hygiene
    // / mo-orchestrator / mo-chat-loop to derive the ledger row from
    // the provider response. Future provider field additions extend
    // the helper, not 8 callsites — this test fails fast if the
    // mapping drifts.
    const input = spendInputFromLLMResponse(
      { kind: 'chat', folderId: 'fld_1' },
      {
        content: 'irrelevant',
        toolCalls: [],
        costUsd: 0.0042,
        model: 'x-ai/grok-4.1-fast',
        tokensIn: 1200,
        tokensOut: 350,
        cachedTokens: 800,
        cacheWriteTokens: 50,
        reasoningTokens: 120,
        providerName: 'openrouter',
      },
    );
    expect(input).toEqual({
      kind: 'chat',
      folderId: 'fld_1',
      costUsd: 0.0042,
      provider: 'openrouter',
      model: 'x-ai/grok-4.1-fast',
      promptTokens: 1200,
      completionTokens: 350,
      cachedTokens: 800,
      cacheWriteTokens: 50,
      reasoningTokens: 120,
      authMode: null,
    });
  });

  it('spendInputFromLLMResponse coerces undefined / missing optional fields to null', () => {
    // Groq / Ollama paths set their optional fields to null
    // explicitly, but older fakes / test stubs may simply omit them.
    // The helper treats `undefined` the same as `null` so the DB
    // schema-NULL never becomes the string `"undefined"`.
    const input = spendInputFromLLMResponse(
      { kind: 'mo_indexing_tier1' },
      {
        content: '',
        toolCalls: [],
        costUsd: 0.001,
        model: 'llama-3.3-70b',
        tokensIn: 500,
        tokensOut: 80,
        // No cachedTokens / cacheWriteTokens / reasoningTokens /
        // providerName at all.
      },
    );
    expect(input.provider).toBeNull();
    expect(input.cachedTokens).toBeNull();
    expect(input.cacheWriteTokens).toBeNull();
    expect(input.reasoningTokens).toBeNull();
  });

  it('persists auth_mode and surfaces it on MoSpendRow (slice 11 — billing context)', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    ledger.record(
      {
        kind: 'auto-code-fix',
        folderId: 'fld_1',
        costUsd: 0.42,
        authMode: 'subscription',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      },
      now,
    );
    ledger.record(
      {
        kind: 'auto-code-fix',
        folderId: 'fld_1',
        costUsd: 0.08,
        authMode: 'api',
      },
      now + 1,
    );
    ledger.record(
      // Legacy / Mo provider rows — no hint.
      { kind: 'mo_indexing_tier1', folderId: 'fld_1', costUsd: 0.001 },
      now + 2,
    );
    const rows = ledger.recent(10);
    expect(rows[0].authMode).toBeNull(); // mo_indexing_tier1 — no hint
    expect(rows[1].authMode).toBe('api');
    expect(rows[2].authMode).toBe('subscription');
  });

  it('reasoning + cache columns survive a folder cascade SET NULL', () => {
    // Same invariant as the existing folder-cascade test, extended
    // to verify the new columns aren't lost when the folder FK
    // resets to NULL.
    ledger.record({
      kind: 'mo_tool',
      folderId: 'fld_1',
      costUsd: 0.01,
      provider: 'openai',
      model: 'gpt-5-mini',
      promptTokens: 500,
      completionTokens: 80,
      reasoningTokens: 240,
    });
    db.prepare('DELETE FROM folders WHERE id = ?').run('fld_1');
    const rows = ledger.recent(1);
    expect(rows[0].folderId).toBeNull();
    expect(rows[0].reasoningTokens).toBe(240);
    expect(rows[0].provider).toBe('openai');
  });
});
