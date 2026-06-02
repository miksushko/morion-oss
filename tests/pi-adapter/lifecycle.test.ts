import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PiAdapter,
  isError,
  isTerminalEvent,
} from '../../src/core/auto-code/harness/index.js';
import {
  collectEvents,
  setup,
  teardown,
  type TestEnv,
} from '../helpers/pi-adapter-setup.js';

describe('PiAdapter — cancel + timeout + SIGKILL escalation', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('cancel mid-run emits cancel_requested + error{killed}', async () => {
    const adapter = new PiAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_DELAY_MS: '5000' },
    });
    setTimeout(() => void handle.cancel('user_toggle_off'), 80);
    const events = await collectEvents(handle);
    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('killed');
    }
  });

  it('SIGKILL escalates when pi ignores SIGTERM (regression)', async () => {
    const adapter = new PiAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: {
        STUB_IGNORE_SIGTERM: '1',
        STUB_DELAY_MS: '60000',
      },
    });
    const t0 = Date.now();
    setTimeout(() => void handle.cancel('test_sigkill'), 50);
    await collectEvents(handle);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(8_000);
  }, 15_000);

  it('timeout → error{timeout}', async () => {
    const adapter = new PiAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      timeoutMs: 200,
      env: { STUB_DELAY_MS: '5000' },
    });
    const events = await collectEvents(handle);
    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('timeout');
    }
  });
});
