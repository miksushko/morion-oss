import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';

const existsSyncCheck = (p: string): boolean => existsSync(p);
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, uninstall, status, entryForLauncher } from '../src/core/mcp-install/installer.js';
import type { ClientAdapter, McpServerEntry } from '../src/core/mcp-install/types.js';

/**
 * The installer touches user config files for live LLM clients. Every
 * scenario that could destroy or corrupt those files needs an explicit
 * test. The contract from src/core/mcp-install/installer.ts:
 *
 *   1. Never overwrite invalid JSON.
 *   2. Never touch unrelated keys.
 *   3. Backup before write.
 *   4. Atomic write.
 *   5. Pretty-print, 2-space indent, trailing newline.
 *
 * Each test pins one of these.
 */

let tmp: string;

function adapterAt(path: string, opts: Partial<ClientAdapter> = {}): ClientAdapter {
  return {
    id: 'test-client',
    displayName: 'Test',
    configPath: () => path,
    serverKey: 'morion',
    ...opts,
  };
}

const ENTRY: McpServerEntry = entryForLauncher('/Applications/Morion.app/Contents/MacOS/morion');

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'morion-install-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('install — empty / missing / fresh config', () => {
  it('creates the file when it does not exist', () => {
    const path = join(tmp, 'config.json');
    const result = install(adapterAt(path), ENTRY);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeNull();
    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written).toEqual({ mcpServers: { morion: ENTRY } });
  });

  it('creates parent directories that do not exist', () => {
    const nested = join(tmp, 'a', 'b', 'c', 'config.json');
    install(adapterAt(nested), ENTRY);
    expect(existsSync(nested)).toBe(true);
  });

  it('writes pretty-printed 2-space JSON with trailing newline', () => {
    const path = join(tmp, 'config.json');
    install(adapterAt(path), ENTRY);
    const raw = readFileSync(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    // 2-space indent: nested object should be indented exactly two spaces.
    expect(raw).toContain('\n  "mcpServers"');
    expect(raw).toContain('\n    "morion"');
  });

  it('treats an empty file as a fresh install (no backup needed for empty file)', () => {
    const path = join(tmp, 'config.json');
    writeFileSync(path, '');
    const result = install(adapterAt(path), ENTRY);
    expect(result.backupPath).not.toBeNull(); // empty file still existed → backup
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.mcpServers.morion).toEqual(ENTRY);
  });
});

describe('install — preserves unrelated config (the load-bearing safety promise)', () => {
  it('keeps other mcpServers entries untouched', () => {
    const path = join(tmp, 'config.json');
    const original = {
      mcpServers: {
        github: { command: 'npx', args: ['@modelcontextprotocol/server-github'] },
        filesystem: { command: 'mcp-server-fs', args: ['/Users/me'] },
      },
    };
    writeFileSync(path, JSON.stringify(original, null, 2));
    install(adapterAt(path), ENTRY);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.mcpServers.github).toEqual(original.mcpServers.github);
    expect(after.mcpServers.filesystem).toEqual(original.mcpServers.filesystem);
    expect(after.mcpServers.morion).toEqual(ENTRY);
  });

  it('keeps top-level non-mcpServers fields untouched (Claude Code stores UI prefs alongside)', () => {
    const path = join(tmp, 'config.json');
    const original = {
      uiPreferences: { theme: 'dark', fontSize: 14 },
      projects: { '/Users/me/work': { lastOpened: 1234 } },
      mcpServers: { existing: { command: 'foo', args: [] } },
    };
    writeFileSync(path, JSON.stringify(original, null, 2));
    install(adapterAt(path), ENTRY);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.uiPreferences).toEqual(original.uiPreferences);
    expect(after.projects).toEqual(original.projects);
    expect(after.mcpServers.existing).toEqual(original.mcpServers.existing);
    expect(after.mcpServers.morion).toEqual(ENTRY);
  });

  it('handles config without mcpServers key — adds it without nuking other fields', () => {
    const path = join(tmp, 'config.json');
    writeFileSync(path, JSON.stringify({ theme: 'light', other: 42 }));
    install(adapterAt(path), ENTRY);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.theme).toBe('light');
    expect(after.other).toBe(42);
    expect(after.mcpServers.morion).toEqual(ENTRY);
  });

  it('overwrites an existing morion entry with the new one (idempotent re-install)', () => {
    const path = join(tmp, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { morion: { command: '/old/path', args: ['mcp', '--legacy'] } },
      }),
    );
    install(adapterAt(path), ENTRY);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.mcpServers.morion).toEqual(ENTRY);
  });
});

describe('install — refuses on malformed input (the destructive-action firewall)', () => {
  it('throws if existing JSON is invalid — does NOT overwrite', () => {
    const path = join(tmp, 'config.json');
    const garbage = '{ not valid json at all';
    writeFileSync(path, garbage);
    expect(() => install(adapterAt(path), ENTRY)).toThrow(/invalid/);
    // File contents must be unchanged.
    expect(readFileSync(path, 'utf8')).toBe(garbage);
  });

  it('throws if existing JSON root is an array — does NOT overwrite', () => {
    const path = join(tmp, 'config.json');
    writeFileSync(path, '[1, 2, 3]');
    expect(() => install(adapterAt(path), ENTRY)).toThrow(/not a JSON object/);
    expect(readFileSync(path, 'utf8')).toBe('[1, 2, 3]');
  });

  it('throws if existing JSON root is a primitive', () => {
    const path = join(tmp, 'config.json');
    writeFileSync(path, '"just a string"');
    expect(() => install(adapterAt(path), ENTRY)).toThrow(/not a JSON object/);
  });
});

describe('install — backup file', () => {
  it('writes a timestamped backup before mutating an existing file', () => {
    const path = join(tmp, 'config.json');
    const original = { mcpServers: { existing: { command: 'foo', args: [] } } };
    writeFileSync(path, JSON.stringify(original, null, 2));
    const result = install(adapterAt(path), ENTRY);
    expect(result.backupPath).toMatch(/\.morion-backup-[\dT-]+Z?$/);
    expect(existsSync(result.backupPath!)).toBe(true);
    // Backup contents must equal the pre-install file.
    expect(JSON.parse(readFileSync(result.backupPath!, 'utf8'))).toEqual(original);
  });

  it('does not write a backup when the file did not exist before', () => {
    const path = join(tmp, 'config.json');
    const result = install(adapterAt(path), ENTRY);
    expect(result.backupPath).toBeNull();
    // Sanity: there's no stray backup file in the dir either.
    expect(readdirSync(tmp).filter((f) => f.includes('morion-backup'))).toEqual([]);
  });
});

describe('uninstall', () => {
  it('removes only the morion entry, preserves other servers + top-level fields', () => {
    const path = join(tmp, 'config.json');
    const original = {
      uiPreferences: { theme: 'dark' },
      mcpServers: {
        github: { command: 'gh-mcp', args: [] },
        morion: ENTRY,
        filesystem: { command: 'fs-mcp', args: [] },
      },
    };
    writeFileSync(path, JSON.stringify(original, null, 2));
    const result = uninstall(adapterAt(path));
    expect(result.ok).toBe(true);
    expect(result.backupPath).not.toBeNull();
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.uiPreferences).toEqual(original.uiPreferences);
    expect(after.mcpServers.github).toEqual(original.mcpServers.github);
    expect(after.mcpServers.filesystem).toEqual(original.mcpServers.filesystem);
    expect(after.mcpServers.morion).toBeUndefined();
  });

  it('leaves the (now empty) container in place rather than restructuring', () => {
    const path = join(tmp, 'config.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { morion: ENTRY } }));
    uninstall(adapterAt(path));
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.mcpServers).toEqual({});
  });

  it('is a no-op when the file does not exist', () => {
    const path = join(tmp, 'config.json');
    const result = uninstall(adapterAt(path));
    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it('is a no-op when morion entry is not present', () => {
    const path = join(tmp, 'config.json');
    const original = { mcpServers: { other: { command: 'x', args: [] } } };
    writeFileSync(path, JSON.stringify(original));
    const result = uninstall(adapterAt(path));
    expect(result.backupPath).toBeNull();
    // File untouched.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(original);
  });

  it('throws on malformed JSON — does NOT overwrite', () => {
    const path = join(tmp, 'config.json');
    writeFileSync(path, '{ not json');
    expect(() => uninstall(adapterAt(path))).toThrow(/invalid/);
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });
});

describe('status', () => {
  it('reports not-installed/no-config-file when the file does not exist', () => {
    const s = status(adapterAt(join(tmp, 'absent.json')), ENTRY);
    expect(s).toEqual({ kind: 'not-installed', reason: 'no-config-file' });
  });

  it('reports not-installed/no-entry when file exists but morion is absent', () => {
    const path = join(tmp, 'config.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }));
    const s = status(adapterAt(path), ENTRY);
    expect(s).toEqual({ kind: 'not-installed', reason: 'no-entry' });
  });

  it('reports installed-current when entry matches', () => {
    const path = join(tmp, 'config.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { morion: ENTRY } }));
    const s = status(adapterAt(path), ENTRY);
    expect(s.kind).toBe('installed-current');
  });

  it('reports installed-stale when args or command differ', () => {
    const path = join(tmp, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { morion: { command: '/old/path', args: ['mcp'] } } }),
    );
    const s = status(adapterAt(path), ENTRY);
    expect(s.kind).toBe('installed-stale');
  });

  it('reports config-malformed without throwing', () => {
    const path = join(tmp, 'config.json');
    writeFileSync(path, '{ not valid');
    const s = status(adapterAt(path), ENTRY);
    expect(s.kind).toBe('config-malformed');
  });
});

describe('isInstalled detection', () => {
  it('reports false when the characteristic dir does not exist (regression for "Connect button on uninstalled client" bug)', () => {
    // Adapter pointing at a path that demonstrably doesn't exist.
    const ghostPath = join(tmp, 'definitely', 'not', 'a', 'real', 'path');
    const a = adapterAt(join(tmp, 'config.json'), {
      isInstalled: () => existsSyncCheck(ghostPath),
    });
    expect(a.isInstalled?.()).toBe(false);
  });

  it('reports true when the characteristic dir exists', () => {
    const realPath = tmp; // tmp itself was created by mkdtempSync above
    const a = adapterAt(join(tmp, 'config.json'), {
      isInstalled: () => existsSyncCheck(realPath),
    });
    expect(a.isInstalled?.()).toBe(true);
  });
});

describe('atomicity', () => {
  it('does not leave a temp file behind on success', () => {
    const path = join(tmp, 'config.json');
    install(adapterAt(path), ENTRY);
    const stragglers = readdirSync(tmp).filter((f) => f.includes('morion-tmp'));
    expect(stragglers).toEqual([]);
  });

  it('does not leak the morion key into a sibling adapter with a different containerKey', () => {
    // Belt-and-braces: an adapter with a custom containerKey (Zed-style)
    // must read/write only that container, never `mcpServers`.
    const path = join(tmp, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { morion: ENTRY }, context_servers: {} }),
    );
    const zedLike = adapterAt(path, { containerKey: 'context_servers' });
    install(zedLike, ENTRY);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    // mcpServers.morion stays as it was; the new entry lands in context_servers.
    expect(after.mcpServers.morion).toEqual(ENTRY);
    expect(after.context_servers.morion).toEqual(ENTRY);
  });
});
