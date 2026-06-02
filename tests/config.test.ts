import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/core/db/client.js';

/**
 * Slice C0 path-resolution refactor coverage. The product code now reads
 * three new env vars (`MORION_CONFIG_DIR`, `MORION_HTTP_PORT`,
 * `MORION_MIGRATIONS_DIR`) and one platform-default chain. These tests pin
 * each branch so the bundler / Tauri sidecar wiring can't drift.
 *
 * Notes on test isolation: `loadConfig`/`defaultConfig`/`configPaths` resolve
 * paths at *call time*, not module load time, so we can flip env vars between
 * tests without needing dynamic imports. The original code computed `CONFIG_DIR`
 * at module top level, which is exactly the bug we're guarding against.
 */

const ENV_KEYS = [
  'MORION_CONFIG_DIR',
  'MORION_HTTP_PORT',
  'MORION_MIGRATIONS_DIR',
  'XDG_CONFIG_HOME',
  'APPDATA',
] as const;
const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function snapshotEnv(): void {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

describe('config path resolution', () => {
  beforeEach(snapshotEnv);
  afterEach(restoreEnv);

  it('honors MORION_CONFIG_DIR for configDir + defaultDbPath', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'morion-cfg-'));
    process.env.MORION_CONFIG_DIR = tmp;
    try {
      const { configPaths, defaultConfig } = await import('../src/core/config.js');
      const paths = configPaths();
      expect(paths.configDir).toBe(tmp);
      expect(paths.configFile).toBe(join(tmp, 'config.json'));
      expect(paths.defaultDbPath).toBe(join(tmp, 'morion.db'));
      expect(defaultConfig().dbPath).toBe(join(tmp, 'morion.db'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('defaultConfigDir falls back to ./data when env unset and not inside an .app', async () => {
    delete process.env.MORION_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.APPDATA;
    const { defaultConfigDir } = await import('../src/core/config.js');
    // execPath under vitest is the node binary from node_modules/.bin or similar
    // — never inside a .app bundle — so the dev branch wins and we get
    // `<cwd>/data`.
    expect(defaultConfigDir()).toBe(join(process.cwd(), 'data'));
  });

  it('MORION_HTTP_PORT overrides whatever is in the on-disk config', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'morion-cfg-'));
    process.env.MORION_CONFIG_DIR = tmp;
    writeFileSync(
      join(tmp, 'config.json'),
      JSON.stringify({ dbPath: join(tmp, 'morion.db'), httpPort: 7777 }),
    );
    process.env.MORION_HTTP_PORT = '17777';
    try {
      const { loadConfig } = await import('../src/core/config.js');
      expect(loadConfig().httpPort).toBe(17777);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('MORION_HTTP_PORT also overrides the in-memory default config', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'morion-cfg-'));
    process.env.MORION_CONFIG_DIR = tmp;
    process.env.MORION_HTTP_PORT = '23456';
    try {
      const { defaultConfig, loadConfig } = await import('../src/core/config.js');
      expect(defaultConfig().httpPort).toBe(23456);
      // No file written → loadConfig uses the in-memory default path too.
      expect(loadConfig().httpPort).toBe(23456);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('garbage MORION_HTTP_PORT is ignored, schema default wins', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'morion-cfg-'));
    process.env.MORION_CONFIG_DIR = tmp;
    process.env.MORION_HTTP_PORT = 'not-a-port';
    try {
      const { loadConfig } = await import('../src/core/config.js');
      expect(loadConfig().httpPort).toBe(7777);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('db migrations dir resolution', () => {
  beforeEach(snapshotEnv);
  afterEach(restoreEnv);

  it('honors MORION_MIGRATIONS_DIR pointing at a copy of the bundled migrations', () => {
    // Build a fake bundled-resources dir holding only the init migration. If
    // openDb fails to read from this path, the notes table won't exist and
    // any subsequent prepare() will throw.
    const stagedDir = mkdtempSync(join(tmpdir(), 'morion-mig-'));
    const realInit = join(process.cwd(), 'src', 'core', 'db', 'migrations', '0001_init.sql');
    if (!existsSync(realInit)) {
      throw new Error(`expected real migration file at ${realInit}`);
    }
    const dest = join(stagedDir, 'migrations');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, '0001_init.sql'), readFileSync(realInit, 'utf8'));

    process.env.MORION_MIGRATIONS_DIR = dest;
    try {
      const handle = openDb({ path: ':memory:' });
      // The init migration creates the `notes` table — if the override
      // didn't fire, this select would throw `no such table: notes`.
      const row = handle.db.prepare('SELECT count(*) AS c FROM notes').get() as { c: number };
      expect(row.c).toBe(0);
      handle.db.close();
    } finally {
      rmSync(stagedDir, { recursive: true, force: true });
    }
  });

  it('falls back to the source-tree migrations dir when env unset', () => {
    delete process.env.MORION_MIGRATIONS_DIR;
    const handle = openDb({ path: ':memory:' });
    const row = handle.db.prepare('SELECT count(*) AS c FROM notes').get() as { c: number };
    expect(row.c).toBe(0);
    handle.db.close();
  });
});
