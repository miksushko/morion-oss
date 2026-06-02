import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  AgentSpawnError,
  ClaudeAdapter,
} from '../../src/core/auto-code/harness/index.js';
import {
  collectEvents,
  readArgsLog,
  setup,
  teardown,
  type TestEnv,
} from '../helpers/claude-adapter-setup.js';

/**
 * ClaudeAdapter resume + multi-consumer iteration. Both small enough
 * to share one scenario file — they exercise different concerns
 * (resume = same session-id continuation; multi-consumer = two
 * iterators consuming the same event stream) but neither needs more
 * than a couple of cases.
 */

describe('ClaudeAdapter (L1.T3) — resume', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('resume creates a new handle with --resume + same sessionId', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'first turn',
      cwd: env.workDir,
      sessionId: 'sess-resume',
      env: { STUB_LOG_ARGS_TO: env.argsLogPath },
    });
    await collectEvents(handle);

    const argsLog2 = join(env.workDir, 'argv2.json');
    const resumed = await handle.resume('continue with this');
    // Resume runs in the same cwd. Need to override argsLog target.
    // The resume call doesn't accept an env parameter — the second
    // run inherits the original env. We reuse the same argsLog
    // file; the resume run overwrites it with its own argv.
    await collectEvents(resumed);

    const log = readArgsLog(env); // Was overwritten by the resume run.
    expect(log.args).toContain('--resume');
    expect(log.args).toContain('sess-resume');
    // Resume passes the injected message as -p value.
    expect(log.args).toContain('-p');
    expect(log.args).toContain('continue with this');
    // No --session-id on resume path (we use --resume instead).
    expect(log.args).not.toContain('--session-id');

    expect(resumed.sessionId).toBe('sess-resume');
    // Reference argsLog2 to keep the variable in scope and
    // prevent typo-style unused warnings.
    void argsLog2;
  });

  it('resume throws if handle has not closed yet', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_DELAY_MS: '5000' },
    });
    // Don't drain — handle is still running.
    await expect(handle.resume('mid-run')).rejects.toBeInstanceOf(
      AgentSpawnError,
    );
    // Cleanup: cancel + drain to free the child.
    void handle.cancel('test_cleanup');
    await collectEvents(handle);
  });
});

describe('ClaudeAdapter (L1.T3) — multi-consumer events', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('two iterators see the same events in the same order', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_RESULT: 'shared output' },
    });
    const a = collectEvents(handle);
    const b = collectEvents(handle);
    const [eventsA, eventsB] = await Promise.all([a, b]);
    expect(eventsA).toHaveLength(2);
    expect(eventsB).toHaveLength(2);
    expect(eventsA[0]!.kind).toBe('session_start');
    expect(eventsB[0]!.kind).toBe('session_start');
    expect(eventsA).toEqual(eventsB);
  });
});
