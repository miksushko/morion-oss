import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  BudgetTracker,
  BudgetExceededError,
  MONTHLY_CAP_USD,
  MoSpendLedgerRepository,
  startOfUtcMonth,
  startOfNextUtcMonth,
  NoopLLMProvider,
  OpenRouterProvider,
  GroqProvider,
  defaultSettings,
} from '../src/core/concierge/index.js';
import { openDb } from '../src/core/db/client.js';

function freshDb() {
  // Use an on-disk temp path so migrations + FKs behave like prod. The
  // openDb helper runs our numbered SQL migrations including 0011.
  const { db } = openDb({ path: ':memory:' });
  // Seed one folder so the per-folder settings FK has a parent.
  db.prepare(
    `INSERT INTO folders (id, name, position, created_at) VALUES (?, ?, 0, ?)`,
  ).run('fld_1', 'Test', Date.now());
  return db;
}

describe('ConciergeFolderSettingsRepository', () => {
  let db: Database.Database;
  let repo: ConciergeFolderSettingsRepository;

  beforeEach(() => {
    db = freshDb();
    repo = new ConciergeFolderSettingsRepository(db);
  });

  it('returns defaults for a folder that has no row', () => {
    const s = repo.getOrDefault('fld_1');
    expect(s.enabled).toBe(false);
    expect(s.linkedRepoPath).toBeNull();
    expect(s.autoCodeEnabled).toBe(false);
    expect(s.topicExclusions).toBe('');
  });

  it('upserts on first update and merges on subsequent updates', () => {
    const first = repo.update('fld_1', { enabled: true, linkedRepoPath: '/repo' });
    expect(first.enabled).toBe(true);
    expect(first.linkedRepoPath).toBe('/repo');

    const second = repo.update('fld_1', { topicExclusions: 'task management' });
    expect(second.enabled).toBe(true); // preserved from first
    expect(second.linkedRepoPath).toBe('/repo'); // preserved
    expect(second.topicExclusions).toBe('task management');
  });

  it('listEnabled returns only folders with enabled=1', () => {
    db.prepare(
      `INSERT INTO folders (id, name, position, created_at) VALUES (?, ?, 1, ?)`,
    ).run('fld_2', 'Other', Date.now());
    repo.update('fld_1', { enabled: true });
    repo.update('fld_2', { enabled: false });
    const enabled = repo.listEnabled();
    expect(enabled.map((s) => s.folderId)).toEqual(['fld_1']);
  });

  it('defaultSettings returns a full shape without touching the DB', () => {
    const s = defaultSettings('fld_99', 42);
    expect(s.folderId).toBe('fld_99');
    expect(s.createdAt).toBe(42);
    expect(s.enabled).toBe(false);
  });

});

describe('ConciergeSessionsRepository', () => {
  let db: Database.Database;
  let sessions: ConciergeSessionsRepository;

  beforeEach(() => {
    db = freshDb();
    sessions = new ConciergeSessionsRepository(db);
  });

  it('create + get + list round-trip', () => {
    const a = sessions.create({ folderId: 'fld_1', title: 'First', openedBy: 'user' });
    const b = sessions.create({ folderId: null, title: 'Ask', openedBy: 'concierge', needsHuman: true });
    expect(sessions.get(a.id)?.title).toBe('First');
    expect(sessions.get(b.id)?.needsHuman).toBe(true);
    const list = sessions.list();
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]); // updated_at DESC
  });

  it('countNeedsHuman returns count of unarchived sessions awaiting human', () => {
    sessions.create({ openedBy: 'user' });
    const q1 = sessions.create({ openedBy: 'concierge', needsHuman: true });
    const q2 = sessions.create({ openedBy: 'concierge', needsHuman: true });
    expect(sessions.countNeedsHuman()).toBe(2);
    sessions.setNeedsHuman(q1.id, false);
    expect(sessions.countNeedsHuman()).toBe(1);
    sessions.archive(q2.id);
    expect(sessions.countNeedsHuman()).toBe(0); // archived excluded
  });

  it('archive hides from default list but includeArchived surfaces it', () => {
    const s = sessions.create({ openedBy: 'user' });
    sessions.archive(s.id);
    expect(sessions.list()).toHaveLength(0);
    expect(sessions.list({ includeArchived: true })).toHaveLength(1);
    sessions.unarchive(s.id);
    expect(sessions.list()).toHaveLength(1);
  });

  it('delete cascades to messages', () => {
    const messages = new ConciergeMessagesRepository(db);
    const s = sessions.create({ openedBy: 'user' });
    messages.create({ sessionId: s.id, role: 'user', content: 'hi' });
    expect(messages.listBySession(s.id)).toHaveLength(1);
    sessions.delete(s.id);
    expect(messages.listBySession(s.id)).toHaveLength(0);
  });
});

describe('ConciergeMessagesRepository (transcript ordering)', () => {
  let db: Database.Database;
  let sessions: ConciergeSessionsRepository;
  let messages: ConciergeMessagesRepository;

  beforeEach(() => {
    db = freshDb();
    sessions = new ConciergeSessionsRepository(db);
    messages = new ConciergeMessagesRepository(db);
  });

  it('lists messages oldest-first', () => {
    const s = sessions.create({ openedBy: 'user' });
    messages.create({ sessionId: s.id, role: 'system', content: 'you are helpful' }, 10);
    messages.create({ sessionId: s.id, role: 'user', content: 'hi' }, 20);
    messages.create({ sessionId: s.id, role: 'assistant', content: 'hello' }, 30);
    const list = messages.listBySession(s.id);
    expect(list.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });
});

describe('MoSpendLedger + BudgetTracker (monthly cap)', () => {
  let db: Database.Database;
  let ledger: MoSpendLedgerRepository;
  let budget: BudgetTracker;

  beforeEach(() => {
    db = freshDb();
    ledger = new MoSpendLedgerRepository(db);
    budget = new BudgetTracker(ledger);
  });

  it('budget status sums cost_usd from the ledger since the start of UTC month', () => {
    // Mid-month: spend rows from THIS month count, prior month rows do not.
    const now = Date.UTC(2026, 3, 18, 12, 0, 0); // 2026-04-18T12:00:00Z
    const lastMonth = startOfUtcMonth(now) - 24 * 60 * 60 * 1000; // March 31
    ledger.record({ kind: 'chat', costUsd: 10 }, lastMonth);
    ledger.record({ kind: 'tick', folderId: 'fld_1', costUsd: 2.5 }, now);
    ledger.record({ kind: 'brief', folderId: 'fld_1', costUsd: 1.25 }, now + 100);
    const status = budget.status(now + 200);
    expect(status.spentMonthUsd).toBeCloseTo(3.75, 2);
    expect(status.spentMonthBreakdown.tick).toBeCloseTo(2.5, 2);
    expect(status.spentMonthBreakdown.brief).toBeCloseTo(1.25, 2);
    expect(status.spentMonthBreakdown.chat).toBeCloseTo(0, 2);
    expect(status.monthlyCapUsd).toBe(MONTHLY_CAP_USD);
    expect(status.withinBudget).toBe(true);
    expect(status.resetsAt).toBe(startOfNextUtcMonth(now));
  });

  it('status().withinBudget flips to false past the cap (soft advisory for ticks)', () => {
    // Budget remains a soft cap for autonomous ticks — engine flips
    // the tick to dry-run when withinBudget=false but still runs the
    // provider so the user can see would-be actions. Phase 2b+ writes
    // hard-cap via `moBudgetExceededDenial` instead. Reserved
    // `BudgetExceededError` exists for future hard-cap call paths.
    const now = Date.UTC(2026, 3, 18, 12, 0, 0);
    ledger.record({ kind: 'mo_tool', costUsd: MONTHLY_CAP_USD + 0.01 }, now);
    const status = budget.status(now);
    expect(status.withinBudget).toBe(false);
    expect(status.spentMonthUsd).toBeCloseTo(MONTHLY_CAP_USD + 0.01, 2);
  });

  it('BudgetExceededError quotes the monthly numbers', () => {
    const err = new BudgetExceededError({
      spentMonthUsd: 9.95,
      spentMonthBreakdown: { chat: 4, tick: 3, brief: 2.95, mo_tool: 0 },
      monthlyCapUsd: MONTHLY_CAP_USD,
      withinBudget: false,
      resetsAt: Date.UTC(2026, 4, 1, 0, 0, 0),
      spentTodayUsd: 0,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BudgetExceededError');
    expect(err.message).toContain('$9.95');
    expect(err.message).toContain(`$${MONTHLY_CAP_USD}`);
  });

  it('record() drops zero-cost rows so dry-run / free-tier calls do not bloat the ledger', () => {
    const now = Date.UTC(2026, 3, 18, 12, 0, 0);
    budget.record({ kind: 'tick', costUsd: 0 }, now);
    budget.record({ kind: 'tick', costUsd: -0.01 }, now); // defensive
    expect(budget.status(now).spentMonthUsd).toBe(0);
    budget.record({ kind: 'tick', costUsd: 0.5 }, now);
    expect(budget.status(now).spentMonthUsd).toBeCloseTo(0.5, 2);
  });
});

describe('LLM providers', () => {
  it('NoopLLMProvider returns a deterministic "not configured" message', async () => {
    const p = new NoopLLMProvider();
    const resp = await p.complete({
      model: 'anything',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(resp.content).toMatch(/not configured/i);
    expect(resp.costUsd).toBe(0);
    expect(resp.toolCalls).toEqual([]);
  });

  it('OpenRouterProvider rejects a missing or malformed API key', () => {
    expect(() => new OpenRouterProvider('')).toThrow();
    expect(() => new OpenRouterProvider('sk-openai-xxx')).toThrow();
    // Sanity — correct prefix does NOT throw at construction time; we
    // never reach the network in this test.
    expect(() => new OpenRouterProvider('sk-or-v1-fake')).not.toThrow();
  });

  it('GroqProvider rejects a missing or malformed API key', () => {
    expect(() => new GroqProvider('')).toThrow();
    expect(() => new GroqProvider('sk-or-v1-fake')).toThrow();
    expect(() => new GroqProvider('gsk_fake')).not.toThrow();
  });

  it('GroqProvider preserves assistant tool_calls before role=tool follow-ups', async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: unknown = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({
          model: 'openai/gpt-oss-120b',
          choices: [{ message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const provider = new GroqProvider('gsk_fake', {
        endpoint: 'https://example.test/groq',
      });
      await provider.complete({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'user', content: 'Find launch notes' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                name: 'notes_search',
                argumentsJson: '{"query":"launch"}',
              },
            ],
          },
          {
            role: 'tool',
            content: '{"hits":[]}',
            toolCallId: 'call_1',
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const body = requestBody as {
      max_completion_tokens?: number;
      max_tokens?: number;
      messages: Array<{
        role: string;
        tool_call_id?: string;
        tool_calls?: Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>;
      }>;
    };
    expect(body.max_completion_tokens).toBe(2000);
    expect(body.max_tokens).toBeUndefined();
    expect(body.messages[1]!.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'notes_search', arguments: '{"query":"launch"}' },
      },
    ]);
    expect(body.messages[2]!.tool_call_id).toBe('call_1');
  });
});
