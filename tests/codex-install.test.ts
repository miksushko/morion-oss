import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import {
  CODEX_ADAPTER,
  codexInstall,
  codexStatus,
  codexUninstall,
} from '../src/core/mcp-install/codex.js';
import type { McpServerEntry } from '../src/core/mcp-install/types.js';

/**
 * Codex CLI adapter covers the TOML codec path. Same five-point safety
 * contract as the JSON installer — this file pins the TOML-specific
 * failure modes (parse error preserves file, mcp_servers with underscore,
 * round-trip preserves unrelated keys).
 */

let tmp: string;
const ENTRY: McpServerEntry = {
  command: '/Applications/Morion.app/Contents/MacOS/morion',
  args: ['mcp'],
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'morion-codex-'));
  // Redirect CODEX_ADAPTER.configPath to a tmp file by monkey-patching.
  // The adapter is a plain object; this is safer than mocking HOME env.
  (CODEX_ADAPTER as { configPath: () => string }).configPath = () =>
    join(tmp, 'config.toml');
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('codex TOML install', () => {
  it('creates ~/.codex/config.toml with mcp_servers.morion when missing', () => {
    const result = codexInstall(ENTRY);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeNull();
    const raw = readFileSync(result.configPath, 'utf8');
    // Critical: underscore, not hyphen. Codex silently ignores mcp-servers.
    expect(raw).toContain('[mcp_servers.morion]');
    const parsed = parse(raw);
    expect(parsed).toEqual({
      mcp_servers: { morion: { command: ENTRY.command, args: ENTRY.args } },
    });
  });

  it('preserves other mcp_servers entries (the safety promise)', () => {
    const path = join(tmp, 'config.toml');
    const original = [
      '[mcp_servers.github]',
      'command = "npx"',
      'args = ["@modelcontextprotocol/server-github"]',
      '',
      '[mcp_servers.filesystem]',
      'command = "mcp-server-fs"',
      'args = ["/Users/me"]',
      '',
    ].join('\n');
    writeFileSync(path, original);
    codexInstall(ENTRY);
    const after = parse(readFileSync(path, 'utf8')) as {
      mcp_servers: Record<string, { command: string; args: string[] }>;
    };
    expect(after.mcp_servers.github).toEqual({
      command: 'npx',
      args: ['@modelcontextprotocol/server-github'],
    });
    expect(after.mcp_servers.filesystem).toEqual({
      command: 'mcp-server-fs',
      args: ['/Users/me'],
    });
    expect(after.mcp_servers.morion).toEqual({
      command: ENTRY.command,
      args: ENTRY.args,
    });
  });

  it('preserves top-level Codex settings alongside mcp_servers', () => {
    const path = join(tmp, 'config.toml');
    writeFileSync(
      path,
      [
        'model = "gpt-5"',
        'approval_policy = "on-request"',
        '',
        '[mcp_servers.other]',
        'command = "foo"',
        'args = []',
        '',
      ].join('\n'),
    );
    codexInstall(ENTRY);
    const after = parse(readFileSync(path, 'utf8')) as {
      model: string;
      approval_policy: string;
      mcp_servers: Record<string, unknown>;
    };
    expect(after.model).toBe('gpt-5');
    expect(after.approval_policy).toBe('on-request');
    expect(after.mcp_servers.other).toBeDefined();
    expect(after.mcp_servers.morion).toBeDefined();
  });

  it('refuses on malformed TOML — does NOT overwrite', () => {
    const path = join(tmp, 'config.toml');
    const garbage = 'this is [not valid toml\nat all {';
    writeFileSync(path, garbage);
    expect(() => codexInstall(ENTRY)).toThrow(/invalid/i);
    expect(readFileSync(path, 'utf8')).toBe(garbage);
  });

  it('writes a timestamped backup before mutation', () => {
    const path = join(tmp, 'config.toml');
    writeFileSync(path, '[mcp_servers.x]\ncommand = "a"\nargs = []\n');
    const result = codexInstall(ENTRY);
    expect(result.backupPath).toMatch(/morion-backup-/);
    expect(existsSync(result.backupPath!)).toBe(true);
  });
});

describe('codex TOML status', () => {
  it('not-installed when no config file', () => {
    expect(codexStatus(ENTRY)).toEqual({ kind: 'not-installed', reason: 'no-config-file' });
  });

  it('not-installed/no-entry when mcp_servers lacks morion', () => {
    writeFileSync(join(tmp, 'config.toml'), '[mcp_servers.other]\ncommand = "x"\nargs = []\n');
    expect(codexStatus(ENTRY)).toEqual({ kind: 'not-installed', reason: 'no-entry' });
  });

  it('installed-current when entry matches', () => {
    codexInstall(ENTRY);
    expect(codexStatus(ENTRY).kind).toBe('installed-current');
  });

  it('installed-stale when args differ', () => {
    codexInstall({ command: ENTRY.command, args: ['mcp', '--legacy'] });
    expect(codexStatus(ENTRY).kind).toBe('installed-stale');
  });

  it('config-malformed surfaces parse error without throwing', () => {
    writeFileSync(join(tmp, 'config.toml'), '{ this is not toml');
    const s = codexStatus(ENTRY);
    expect(s.kind).toBe('config-malformed');
  });
});

describe('codex TOML uninstall', () => {
  it('removes only morion, leaves other servers intact', () => {
    const path = join(tmp, 'config.toml');
    writeFileSync(
      path,
      [
        '[mcp_servers.keep]',
        'command = "x"',
        'args = []',
        '',
        '[mcp_servers.morion]',
        `command = "${ENTRY.command}"`,
        'args = ["mcp"]',
        '',
      ].join('\n'),
    );
    const r = codexUninstall();
    expect(r.ok).toBe(true);
    expect(r.backupPath).not.toBeNull();
    const after = parse(readFileSync(path, 'utf8')) as {
      mcp_servers: Record<string, unknown>;
    };
    expect(after.mcp_servers.keep).toBeDefined();
    expect(after.mcp_servers.morion).toBeUndefined();
  });

  it('no-op when file does not exist', () => {
    const r = codexUninstall();
    expect(r.ok).toBe(true);
    expect(r.backupPath).toBeNull();
  });
});
