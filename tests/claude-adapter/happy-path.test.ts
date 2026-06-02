import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ClaudeAdapter,
  isResult,
  isSessionStart,
} from '../../src/core/auto-code/harness/index.js';
import {
  collectEvents,
  setup,
  teardown,
  type TestEnv,
} from '../helpers/claude-adapter-setup.js';

/**
 * L1.T3 — ClaudeAdapter happy-path scenarios. session_start + result
 * on a clean run, terminalReason=budget propagation, sessionId
 * generation, getCost() before vs after terminal.
 */
describe('ClaudeAdapter (L1.T3) — happy path', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('emits session_start + result on a clean stub run', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'do the thing',
      cwd: env.workDir,
      sessionId: 'sess-aaa',
      env: {
        STUB_RESULT: 'all done',
        STUB_COST: '0.0123',
      },
    });

    expect(handle.sessionId).toBe('sess-aaa');
    expect(handle.adapter).toBe('claude');
    expect(handle.pid).toBeGreaterThan(0);

    const events = await collectEvents(handle);
    expect(events).toHaveLength(2);

    const start = events[0]!;
    expect(isSessionStart(start)).toBe(true);
    if (isSessionStart(start)) {
      expect(start.sessionId).toBe('sess-aaa');
      expect(start.agent).toBe('claude');
      expect(start.timestamp).toBeGreaterThan(0);
    }

    const result = events[1]!;
    expect(isResult(result)).toBe(true);
    if (isResult(result)) {
      expect(result.summary).toBe('all done');
      expect(result.costUsd).toBeCloseTo(0.0123);
      expect(result.exitCode).toBe(0);
      expect(result.terminalReason).toBe('completed');
    }

    expect(handle.getCost()).toBeCloseTo(0.0123);
  });

  it('terminalReason=budget propagates from claude envelope', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'big task',
      cwd: env.workDir,
      maxBudgetUsd: 0.05,
      env: {
        STUB_TERMINAL_REASON: 'budget',
        STUB_RESULT: 'partial work, budget hit',
        STUB_COST: '0.05',
      },
    });
    const events = await collectEvents(handle);
    const result = events.find(isResult)!;
    expect(result).toBeDefined();
    // Budget stop is NOT a failure → emits result, not error.
    expect(result.terminalReason).toBe('budget');
    expect(result.summary).toBe('partial work, budget hit');
    expect(result.costUsd).toBeCloseTo(0.05);
  });

  it('generates a sessionId when not provided', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_COST: '0' },
    });
    // RFC 4122 v4: 8-4-4-4-12 hex, 36 chars
    expect(handle.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const events = await collectEvents(handle);
    expect(events.find(isSessionStart)?.sessionId).toBe(handle.sessionId);
  });

  it('cost is 0 before the terminal event arrives', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_DELAY_MS: '200', STUB_COST: '0.5' },
    });
    // Before drain — cost defaults to 0.
    expect(handle.getCost()).toBe(0);
    await collectEvents(handle);
    expect(handle.getCost()).toBeCloseTo(0.5);
  });
});
