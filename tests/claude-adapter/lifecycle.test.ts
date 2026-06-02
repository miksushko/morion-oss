import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ClaudeAdapter,
  isError,
  isTerminalEvent,
} from '../../src/core/auto-code/harness/index.js';
import {
  collectEvents,
  setup,
  teardown,
  type TestEnv,
} from '../helpers/claude-adapter-setup.js';

/**
 * ClaudeAdapter lifecycle — cancel mid-run, idempotent cancel,
 * timeout, SIGKILL escalation when SIGTERM is ignored, AbortSignal.
 */
describe('ClaudeAdapter (L1.T3) — cancel + timeout', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('cancel mid-run emits cancel_requested + error{killed}', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_DELAY_MS: '5000' },
    });
    // Cancel after letting the child start.
    setTimeout(() => void handle.cancel('user_toggle_off'), 80);
    const events = await collectEvents(handle);

    const cancelEv = events.find((e) => e.kind === 'cancel_requested');
    expect(cancelEv).toBeDefined();
    if (cancelEv?.kind === 'cancel_requested') {
      expect(cancelEv.reason).toBe('user_toggle_off');
    }

    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('killed');
      expect(terminal.recoverable).toBe(true);
    }
  });

  it('cancel is idempotent — second call resolves cleanly', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_DELAY_MS: '5000' },
    });
    const drain = collectEvents(handle);
    setTimeout(() => void handle.cancel('first'), 50);
    setTimeout(() => void handle.cancel('second'), 100);
    await drain;
    // Should not have thrown; both cancels resolved.
    expect(true).toBe(true);
  });

  it('timeout fires cancel with reason=timeout and error{timeout}', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      timeoutMs: 200,
      env: { STUB_DELAY_MS: '5000' },
    });
    const events = await collectEvents(handle);

    const cancelEv = events.find((e) => e.kind === 'cancel_requested');
    expect(cancelEv).toBeDefined();
    if (cancelEv?.kind === 'cancel_requested') {
      expect(cancelEv.reason).toBe('timeout');
    }

    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('timeout');
      expect(terminal.recoverable).toBe(false);
    }
  });

  it('SIGKILL escalates when the child ignores SIGTERM', async () => {
    // Regression: child.killed flips on the kill() *call*, not on
    // actual exit. Using it to gate the SIGKILL timer skips the
    // escalation entirely for any CLI that ignores SIGTERM. The
    // adapter must use its own _processExited flag instead.
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: {
        STUB_IGNORE_SIGTERM: '1',
        STUB_DELAY_MS: '60000', // long enough that only SIGKILL ends the run
      },
    });
    const t0 = Date.now();
    setTimeout(() => void handle.cancel('test_sigkill'), 50);
    const events = await collectEvents(handle);
    const elapsed = Date.now() - t0;

    // Must terminate within the SIGTERM grace (2s) + slack, not
    // hang for the full 60s STUB_DELAY_MS.
    expect(elapsed).toBeLessThan(8_000);

    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('killed');
    }
  }, 15_000);

  it('AbortSignal aborts via cancel(external_signal)', async () => {
    const controller = new AbortController();
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      signal: controller.signal,
      env: { STUB_DELAY_MS: '5000' },
    });
    setTimeout(() => controller.abort(), 80);
    const events = await collectEvents(handle);

    const cancelEv = events.find((e) => e.kind === 'cancel_requested');
    expect(cancelEv).toBeDefined();
    if (cancelEv?.kind === 'cancel_requested') {
      expect(cancelEv.reason).toBe('external_signal');
    }
  });
});
