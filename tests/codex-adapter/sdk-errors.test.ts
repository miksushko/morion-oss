import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AgentSpawnError,
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

describe('CodexAdapter — SDK error paths', () => {
  let env: CodexTestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('turn.failed → error{ turn_failed }', async () => {
    const { adapter } = makeFakeAdapter(
      () =>
        new FakeThread(null, [
          { type: 'thread.started', thread_id: 't-fail-1' },
          {
            type: 'turn.failed',
            error: { message: 'model API returned 500' },
          },
        ]),
      env.stub.binPath,
    );
    const handle = await adapter.spawn({ prompt: 'x', cwd: env.workDir });
    const events = await collectEvents(handle);
    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('turn_failed');
      expect(terminal.message).toContain('model API returned 500');
      expect(terminal.recoverable).toBe(false);
    }
  });

  it('SDK stream `error` event → error{ sdk_error }', async () => {
    const { adapter } = makeFakeAdapter(
      () =>
        new FakeThread(null, [
          { type: 'thread.started', thread_id: 't-err-1' },
          { type: 'error', message: 'fatal stream error from codex' },
        ]),
      env.stub.binPath,
    );
    const handle = await adapter.spawn({ prompt: 'x', cwd: env.workDir });
    const events = await collectEvents(handle);
    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('sdk_error');
      expect(terminal.message).toContain('fatal stream error');
    }
  });

  it('iterator throws mid-run → terminal error{ sdk_error }', async () => {
    const { adapter } = makeFakeAdapter(
      () =>
        new FakeThread(null, async function* () {
          yield { type: 'thread.started', thread_id: 't-mid-1' };
          throw new Error('codex CLI died mid-stream');
        }),
      env.stub.binPath,
    );
    const handle = await adapter.spawn({ prompt: 'x', cwd: env.workDir });
    const events = await collectEvents(handle);
    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('sdk_error');
      expect(terminal.message).toContain('codex CLI died');
    }
  });

  it('runStreamed throws synchronously → AgentSpawnError', async () => {
    const { adapter } = makeFakeAdapter(
      () => {
        const t = new FakeThread(null, []);
        t.throwOnRun = new Error('codex auth.json missing');
        return t;
      },
      env.stub.binPath,
    );
    await expect(
      adapter.spawn({ prompt: 'x', cwd: env.workDir }),
    ).rejects.toBeInstanceOf(AgentSpawnError);
  });
});
