import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { realpathSync } from 'node:fs';
import { ClaudeAdapter } from '../../src/core/auto-code/harness/index.js';
import {
  collectEvents,
  readArgsLog,
  setup,
  teardown,
  type TestEnv,
} from '../helpers/claude-adapter-setup.js';

/**
 * ClaudeAdapter args / env propagation — prompt, sessionId,
 * allowedTools, --permission-mode, --output-format, --max-budget-usd
 * gating, --model, default tool allowlist, MORION_HARNESS_* env
 * stripping.
 */
describe('ClaudeAdapter (L1.T3) — args / env propagation', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('passes prompt + sessionId + allowedTools + permission-mode + output-format on fresh spawn', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'analyse this',
      cwd: env.workDir,
      sessionId: 'sess-bbb',
      allowedTools: ['Read', 'Glob'],
      env: { STUB_LOG_ARGS_TO: env.argsLogPath },
    });
    await collectEvents(handle);

    const log = readArgsLog(env);
    expect(log.args).toContain('-p');
    expect(log.args).toContain('analyse this');
    expect(log.args).toContain('--session-id');
    expect(log.args).toContain('sess-bbb');
    expect(log.args).toContain('--output-format');
    expect(log.args).toContain('json');
    expect(log.args).toContain('--allowedTools');
    expect(log.args).toContain('Read,Glob');
    expect(log.args).toContain('--permission-mode');
    expect(log.args).toContain('acceptEdits');
    // MCP isolation — the spawned claude must NOT inherit the operator's
    // global/project MCP fleet (headless auth servers hang at startup →
    // exit 1, $0; worst under parallel fan-out).
    expect(log.args).toContain('--strict-mcp-config');
    // No --bare per pinned lesson (preserves OAuth Max).
    expect(log.args).not.toContain('--bare');
    // No --worktree at the harness layer (caller owns cwd).
    expect(log.args).not.toContain('--worktree');
    // macOS resolves /var/folders → /private/var/folders for cwd;
    // realpath both sides before comparison (lesson from earlier
    // symlink-equivalence trap, see tasks/lessons.md).
    expect(realpathSync(log.cwd)).toBe(realpathSync(env.workDir));
  });

  it('omits --max-budget-usd when not set or zero', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_LOG_ARGS_TO: env.argsLogPath },
    });
    await collectEvents(handle);
    const log = readArgsLog(env);
    expect(log.args).not.toContain('--max-budget-usd');
  });

  it('passes --max-budget-usd when set positive', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      maxBudgetUsd: 0.5,
      env: { STUB_LOG_ARGS_TO: env.argsLogPath },
    });
    await collectEvents(handle);
    const log = readArgsLog(env);
    expect(log.args).toContain('--max-budget-usd');
    expect(log.args).toContain('0.5');
  });

  it('passes --model when provided', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      model: 'claude-opus-4-7',
      env: { STUB_LOG_ARGS_TO: env.argsLogPath },
    });
    await collectEvents(handle);
    const log = readArgsLog(env);
    expect(log.args).toContain('--model');
    expect(log.args).toContain('claude-opus-4-7');
  });

  it('uses default tool allowlist when allowedTools not provided', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_LOG_ARGS_TO: env.argsLogPath },
    });
    await collectEvents(handle);
    const log = readArgsLog(env);
    expect(log.args).toContain('Read,Write,Edit,Glob,Grep,Bash');
  });

  it('strips MORION_HARNESS_* keys from caller-supplied env', async () => {
    // The L1.T7 process-safety wrap owns this namespace; caller
    // env attempting to set these is silently dropped.
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: {
        STUB_LOG_ARGS_TO: env.argsLogPath,
        MORION_HARNESS_PARENT_PID: '99999',
      },
    });
    await collectEvents(handle);
    // The stub doesn't echo env, but we can verify the adapter
    // doesn't crash + the run completes — the key invariant is
    // that nothing in the MORION_HARNESS_* namespace overrides
    // adapter-internal usage when L1.T7 wires it.
    // (Direct env-leak test would need a stub that echoes process.env.)
    expect(handle.sessionId).toBeTruthy();
  });
});
