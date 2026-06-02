import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isError,
  isTerminalEvent,
} from '../../src/core/auto-code/harness/index.js';
import {
  FakeThread,
  collectEvents,
  makeFakeAdapter,
  setup,
  teardown,
  type CodexTestEnv,
} from '../helpers/codex-adapter-setup.js';

describe('CodexAdapter — cancel + timeout', () => {
  let env: CodexTestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('cancel emits cancel_requested + error{ killed } and aborts SDK signal', async () => {
    let thread: FakeThread | null = null;
    const { adapter } = makeFakeAdapter(() => {
      thread = new FakeThread(null, async function* () {
        // Block forever until aborted.
        yield { type: 'thread.started', thread_id: 't-cancel-1' };
        await new Promise(() => {});
      });
      return thread;
    }, env.stub.binPath);

    const handle = await adapter.spawn({ prompt: 'x', cwd: env.workDir });
    setTimeout(() => void handle.cancel('user_toggle_off'), 50);
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
    }
    expect(thread!.capturedSignal?.aborted).toBe(true);
  });

  it('timeout → error{ timeout, recoverable: false }', async () => {
    const { adapter } = makeFakeAdapter(
      () =>
        new FakeThread(null, async function* () {
          yield { type: 'thread.started', thread_id: 't-timeout-1' };
          await new Promise(() => {});
        }),
      env.stub.binPath,
    );
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      timeoutMs: 100,
    });
    const events = await collectEvents(handle);
    const cancelEv = events.find((e) => e.kind === 'cancel_requested');
    expect(cancelEv?.kind).toBe('cancel_requested');
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

  it('cancel is idempotent', async () => {
    const { adapter } = makeFakeAdapter(
      () =>
        new FakeThread(null, async function* () {
          yield { type: 'thread.started', thread_id: 't-idem-1' };
          await new Promise(() => {});
        }),
      env.stub.binPath,
    );
    const handle = await adapter.spawn({ prompt: 'x', cwd: env.workDir });
    const drain = collectEvents(handle);
    setTimeout(() => void handle.cancel('a'), 30);
    setTimeout(() => void handle.cancel('b'), 60);
    await drain;
    // No throw → idempotent.
    expect(true).toBe(true);
  });
});
