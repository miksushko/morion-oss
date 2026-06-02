import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentBinaryNotFoundError,
  AgentSpawnError,
  CodexAdapter,
} from '../../src/core/auto-code/harness/index.js';
import { mapCodexLevel } from '../../src/core/auto-code/harness/adapters/codex.js';
import {
  setup,
  teardown,
  type CodexTestEnv,
} from '../helpers/codex-adapter-setup.js';

describe('CodexAdapter — binary resolution', () => {
  let env: CodexTestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it('throws AgentSpawnError when binPath does not exist', async () => {
    const adapter = new CodexAdapter({ binPath: '/nonexistent/codex' });
    await expect(
      adapter.spawn({ prompt: 'x', cwd: env.workDir }),
    ).rejects.toBeInstanceOf(AgentSpawnError);
  });

  it('throws AgentBinaryNotFoundError when nothing on PATH and no env override', async () => {
    const adapter = new CodexAdapter();
    const emptyDir = mkdtempSync(join(tmpdir(), 'morion-codex-empty-'));
    const originalPath = process.env.PATH;
    const originalBin = process.env.MORION_CODEX_BIN;
    try {
      process.env.PATH = emptyDir;
      delete process.env.MORION_CODEX_BIN;
      await expect(
        adapter.spawn({ prompt: 'x', cwd: env.workDir }),
      ).rejects.toBeInstanceOf(AgentBinaryNotFoundError);
    } finally {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      if (originalBin !== undefined) process.env.MORION_CODEX_BIN = originalBin;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('mapCodexLevel', () => {
  it('maps known levels lowercase + case-insensitively', () => {
    expect(mapCodexLevel('Low')).toBe('low');
    expect(mapCodexLevel('MEDIUM')).toBe('medium');
    expect(mapCodexLevel('high')).toBe('high');
    expect(mapCodexLevel('minimal')).toBe('minimal');
    expect(mapCodexLevel('XHigh')).toBe('xhigh');
  });

  it('returns undefined for empty / unknown / Default', () => {
    expect(mapCodexLevel(undefined)).toBeUndefined();
    expect(mapCodexLevel('')).toBeUndefined();
    expect(mapCodexLevel('Default')).toBeUndefined();
    expect(mapCodexLevel('extraplanetary')).toBeUndefined();
  });
});
