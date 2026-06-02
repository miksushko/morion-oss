import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { realpathSync } from 'node:fs';

import { OpencodeAdapter } from '../../src/core/auto-code/harness/index.js';
import {
  collectEvents,
  readArgsLog,
  setupOpencodeEnv,
  teardownOpencodeEnv,
  type OpencodeTestEnv,
} from '../helpers/opencode-adapter-setup.js';

/**
 * OpencodeAdapter (L1.T6) — argv propagation. Verifies that the
 * adapter passes the right flags (run / --format json /
 * --dangerously-skip-permissions / --model / --session) and omits
 * the ones opencode lacks (--allowedTools / --max-budget-usd).
 */

describe('OpencodeAdapter — args propagation', () => {
  let env: OpencodeTestEnv;
  beforeEach(() => {
    env = setupOpencodeEnv();
  });
  afterEach(() => teardownOpencodeEnv(env));

  it('passes run + --format json + --dangerously-skip-permissions + prompt; OMITS --session on fresh', async () => {
    const adapter = new OpencodeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'analyse',
      cwd: env.workDir,
      env: { STUB_LOG_ARGS_TO: env.argsLogPath },
    });
    await collectEvents(handle);
    const log = readArgsLog(env);
    expect(log.args).toContain('run');
    expect(log.args).toContain('--format');
    expect(log.args).toContain('json');
    expect(log.args).toContain('--dangerously-skip-permissions');
    expect(log.args).toContain('analyse');
    expect(log.args).not.toContain('--session');
    expect(realpathSync(log.cwd)).toBe(realpathSync(env.workDir));
  });

  it('does NOT pass --allowedTools or maxBudgetUsd flags (opencode lacks them)', async () => {
    const adapter = new OpencodeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      allowedTools: ['Read', 'Bash'],
      maxBudgetUsd: 1.0,
      env: { STUB_LOG_ARGS_TO: env.argsLogPath },
    });
    await collectEvents(handle);
    const log = readArgsLog(env);
    expect(log.args).not.toContain('--allowedTools');
    expect(log.args).not.toContain('--max-budget-usd');
  });

  it('passes --model when set', async () => {
    const adapter = new OpencodeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      model: 'qwen-coder',
      env: { STUB_LOG_ARGS_TO: env.argsLogPath },
    });
    await collectEvents(handle);
    const log = readArgsLog(env);
    expect(log.args).toContain('--model');
    expect(log.args).toContain('qwen-coder');
  });
});
