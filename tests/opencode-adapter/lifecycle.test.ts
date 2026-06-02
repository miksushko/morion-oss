import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentBinaryNotFoundError,
  AgentSpawnError,
  OpencodeAdapter,
  isError,
  isTerminalEvent,
} from '../../src/core/auto-code/harness/index.js';
import {
  collectEvents,
  readArgsLog,
  setupOpencodeEnv,
  teardownOpencodeEnv,
  type OpencodeTestEnv,
} from '../helpers/opencode-adapter-setup.js';

/**
 * OpencodeAdapter (L1.T6) — lifecycle: binary resolution failures,
 * cancel / timeout / SIGKILL escalation, resume with the
 * opencode-authoritative session id.
 */

describe('OpencodeAdapter — failure modes (binary resolution)', () => {
  let env: OpencodeTestEnv;
  beforeEach(() => {
    env = setupOpencodeEnv();
  });
  afterEach(() => teardownOpencodeEnv(env));

  it('throws AgentSpawnError when binPath does not exist', async () => {
    const adapter = new OpencodeAdapter({ binPath: '/nonexistent/opencode' });
    await expect(
      adapter.spawn({ prompt: 'x', cwd: env.workDir }),
    ).rejects.toBeInstanceOf(AgentSpawnError);
  });

  it('throws AgentBinaryNotFoundError when no binary on PATH', async () => {
    const adapter = new OpencodeAdapter();
    const emptyDir = mkdtempSync(join(tmpdir(), 'morion-opencode-empty-'));
    const originalPath = process.env.PATH;
    const originalBin = process.env.MORION_OPENCODE_BIN;
    try {
      process.env.PATH = emptyDir;
      delete process.env.MORION_OPENCODE_BIN;
      await expect(
        adapter.spawn({ prompt: 'x', cwd: env.workDir }),
      ).rejects.toBeInstanceOf(AgentBinaryNotFoundError);
    } finally {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      if (originalBin !== undefined) process.env.MORION_OPENCODE_BIN = originalBin;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('OpencodeAdapter — cancel + timeout + SIGKILL escalation', () => {
  let env: OpencodeTestEnv;
  beforeEach(() => {
    env = setupOpencodeEnv();
  });
  afterEach(() => teardownOpencodeEnv(env));

  it('cancel mid-run emits cancel_requested + error{killed}', async () => {
    const adapter = new OpencodeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_DELAY_MS: '5000' },
    });
    setTimeout(() => void handle.cancel('user_toggle_off'), 80);
    const events = await collectEvents(handle);
    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) expect(terminal.errorKind).toBe('killed');
  });

  it('SIGKILL escalates when opencode ignores SIGTERM (regression)', async () => {
    const adapter = new OpencodeAdapter({ binPath: env.stub.binPath });
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
    const adapter = new OpencodeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      timeoutMs: 200,
      env: { STUB_DELAY_MS: '5000' },
    });
    const events = await collectEvents(handle);
    const terminal = events.find(isTerminalEvent)!;
    if (isError(terminal)) expect(terminal.errorKind).toBe('timeout');
  });
});

describe('OpencodeAdapter — resume', () => {
  let env: OpencodeTestEnv;
  beforeEach(() => {
    env = setupOpencodeEnv();
  });
  afterEach(() => teardownOpencodeEnv(env));

  it('resume passes --session = opencode-authoritative id (NOT caller UUID)', async () => {
    const adapter = new OpencodeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'first',
      cwd: env.workDir,
      sessionId: 'caller-uuid-bbb',
      env: {
        STUB_SESSION_ID: 'opencode-auth-xyz',
        STUB_LOG_ARGS_TO: env.argsLogPath,
      },
    });
    await collectEvents(handle);
    // Codex T10 review P1: streaming adapter requires `exited`
    // before resume so prior child fully releases lockfile.
    await handle.exited;
    const resumed = await handle.resume('continue');
    await collectEvents(resumed);
    await resumed.exited;
    const log = readArgsLog(env);
    expect(log.args).toContain('--session');
    expect(log.args).toContain('opencode-auth-xyz');
    expect(log.args).not.toContain('caller-uuid-bbb');
    expect(log.args).toContain('continue');
    expect(resumed.sessionId).toBe('opencode-auth-xyz');
  });
});
