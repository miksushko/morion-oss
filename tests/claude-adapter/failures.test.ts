import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentBinaryNotFoundError,
  AgentSpawnError,
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
 * ClaudeAdapter failure modes — claude-reported error envelope vs
 * crash-without-envelope, AgentSpawnError on bad binPath, async
 * EACCES, AgentBinaryNotFoundError when nothing on PATH.
 */
describe('ClaudeAdapter (L1.T3) — failure modes', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('claude-reported error → error event with non_zero_exit', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: {
        STUB_TERMINAL_REASON: 'error',
        STUB_RESULT: 'something broke',
      },
    });
    const events = await collectEvents(handle);
    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('non_zero_exit');
      expect(terminal.message).toContain('something broke');
      expect(terminal.recoverable).toBe(false);
    }
  });

  it('crash without JSON envelope → error event with parse_failed', async () => {
    const adapter = new ClaudeAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: {
        STUB_EXIT_CODE: '1',
        STUB_STDERR: 'something went wrong\n',
      },
    });
    const events = await collectEvents(handle);
    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('parse_failed');
      // stderr tail should surface in the message
      expect(terminal.message).toContain('something went wrong');
    }
  });

  it('throws AgentSpawnError when binPath does not exist', async () => {
    const adapter = new ClaudeAdapter({
      binPath: '/nonexistent/path/to/claude',
    });
    await expect(
      adapter.spawn({ prompt: 'x', cwd: env.workDir }),
    ).rejects.toBeInstanceOf(AgentSpawnError);
  });

  it('rejects spawn() promise on async ENOENT/EACCES (not stream error)', async () => {
    // Create a non-executable file that exists. spawn() returns a
    // child object, then 'error' fires async with EACCES — must
    // surface as a thrown promise rejection per the adapter
    // contract, not as an in-stream error event.
    const dir = mkdtempSync(join(tmpdir(), 'morion-claude-noexec-'));
    const fakePath = join(dir, 'claude');
    writeFileSync(fakePath, 'not a real script\n');
    // chmod 0644 — readable but not executable
    chmodSync(fakePath, 0o644);
    try {
      const adapter = new ClaudeAdapter({ binPath: fakePath });
      await expect(
        adapter.spawn({ prompt: 'x', cwd: env.workDir }),
      ).rejects.toBeInstanceOf(AgentSpawnError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws AgentBinaryNotFoundError when no binary on PATH and no env override', async () => {
    const adapter = new ClaudeAdapter();
    // Force resolution to fail by pointing PATH at an empty dir.
    const emptyDir = mkdtempSync(join(tmpdir(), 'morion-claude-empty-'));
    const originalPath = process.env.PATH;
    const originalBin = process.env.MORION_CLAUDE_BIN;
    try {
      process.env.PATH = emptyDir;
      delete process.env.MORION_CLAUDE_BIN;
      await expect(
        adapter.spawn({ prompt: 'x', cwd: env.workDir }),
      ).rejects.toBeInstanceOf(AgentBinaryNotFoundError);
    } finally {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      if (originalBin !== undefined) process.env.MORION_CLAUDE_BIN = originalBin;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
