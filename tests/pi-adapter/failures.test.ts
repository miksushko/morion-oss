import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentBinaryNotFoundError,
  AgentSpawnError,
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

describe('PiAdapter — failure modes', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('clean exit without agent_end → error{parse_failed}', async () => {
    const adapter = new PiAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: { STUB_NO_AGENT_END: '1' },
    });
    const events = await collectEvents(handle);
    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('parse_failed');
      expect(terminal.recoverable).toBe(false);
    }
  });

  it('non-zero exit → error{non_zero_exit}', async () => {
    const adapter = new PiAdapter({ binPath: env.stub.binPath });
    const handle = await adapter.spawn({
      prompt: 'x',
      cwd: env.workDir,
      env: {
        STUB_EXIT_CODE: '3',
        STUB_STDERR: 'pi crashed\n',
      },
    });
    const events = await collectEvents(handle);
    const terminal = events.find(isTerminalEvent)!;
    expect(isError(terminal)).toBe(true);
    if (isError(terminal)) {
      expect(terminal.errorKind).toBe('non_zero_exit');
      expect(terminal.message).toContain('pi crashed');
    }
  });

  it('throws AgentSpawnError when binPath does not exist', async () => {
    const adapter = new PiAdapter({ binPath: '/nonexistent/pi' });
    await expect(
      adapter.spawn({ prompt: 'x', cwd: env.workDir }),
    ).rejects.toBeInstanceOf(AgentSpawnError);
  });

  it('throws AgentBinaryNotFoundError when no binary on PATH', async () => {
    const adapter = new PiAdapter();
    const emptyDir = mkdtempSync(join(tmpdir(), 'morion-pi-empty-'));
    const originalPath = process.env.PATH;
    const originalBin = process.env.MORION_PI_BIN;
    try {
      process.env.PATH = emptyDir;
      delete process.env.MORION_PI_BIN;
      await expect(
        adapter.spawn({ prompt: 'x', cwd: env.workDir }),
      ).rejects.toBeInstanceOf(AgentBinaryNotFoundError);
    } finally {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      if (originalBin !== undefined) process.env.MORION_PI_BIN = originalBin;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
