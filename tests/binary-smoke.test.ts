import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ALL_TOOLS } from '../src/server/tools/index.js';

/**
 * Smoke test for the packaged binary produced by `npm run package:bin`.
 *
 * This is the Slice C1 deliverable's regression net. It does NOT replace
 * tests/mcp-stdio.test.ts (which already walks every tool through tsx);
 * the bundled binary is the same code with the same tests behind it. What
 * this file proves is the *packaging* itself: that the launcher script
 * resolves its own dir, that the bundled node finds the bundled CLI, that
 * the bundled node_modules resolves better-sqlite3 + sqlite-vec correctly,
 * and that the path resolvers in src/server/http.ts and src/core/db/client.ts
 * land on the dist-bin/app/{web/dist,core/db/migrations} layout.
 *
 * The test SKIPS itself entirely if `dist-bin/morion` doesn't exist — local
 * `npm test` runs without `npm run package:bin` having been run first should
 * not fail. CI will run them in order.
 *
 * Embeddings are forced to noop via a temp config so the bundled binary
 * never tries to download the 120 MB Hugging Face model.
 */

const PROJECT_ROOT = resolve(__dirname, '..');
const BIN = resolve(PROJECT_ROOT, 'dist-bin/morion');
const HAS_BIN = existsSync(BIN);

// ⚠️  Staleness guard — 2026-04-17. The previous shape
// `existsSync(BIN) ? describe : describe.skip` meant "run if
// dist-bin exists, else skip". That's wrong in a subtle way: if
// dist-bin exists but is OLDER than the source you're testing, the
// suite happily passes against stale code and confirms nothing.
// v0.99.4 shipped with a broken sidecar BECAUSE this test passed
// locally + in CI against a dist-bin built before the R4 change —
// the trap is documented in tasks/lessons.md 2026-04-17
// "binary-smoke must own its rebuild, or it lies".
//
// Guard: if a key source file (`src/core/version.ts` as a canary)
// is newer than its compiled counterpart in dist-bin, fail the
// suite loudly — the operator then knows to run `npm run package:bin`
// and retry. Absence of dist-bin still skips (same as before) —
// that's the "haven't built yet" case, not a staleness bug.
function dispositionSkipOrStale(): 'run' | 'skip' | 'stale' {
  if (!HAS_BIN) return 'skip';
  const canarySrc = resolve(PROJECT_ROOT, 'src/core/version.ts');
  const canaryDist = resolve(PROJECT_ROOT, 'dist-bin/app/core/version.js');
  if (!existsSync(canarySrc) || !existsSync(canaryDist)) return 'run'; // probably packaging-style we don't know about; don't block
  const srcMtime = statSync(canarySrc).mtimeMs;
  const distMtime = statSync(canaryDist).mtimeMs;
  // 2-second slop so a `cp -p` or filesystem with coarse mtime
  // doesn't false-positive.
  if (srcMtime > distMtime + 2000) return 'stale';
  return 'run';
}

const DISPOSITION = dispositionSkipOrStale();
const d = DISPOSITION === 'run' ? describe : describe.skip;

// If dist-bin is stale, fail LOUDLY instead of just skipping the
// real suite — this is the bug class the whole file exists to
// prevent. Skipping silently is exactly what let v0.99.4 ship
// broken.
if (DISPOSITION === 'stale') {
  describe('binary-smoke staleness guard', () => {
    it('fails because dist-bin is older than source — run `npm run package:bin` and retry', () => {
      throw new Error(
        'dist-bin/app/core/version.js is older than src/core/version.ts. ' +
          'The packaged binary is stale; binary-smoke against it would ' +
          'exercise old code. Run `npm run package:bin` to rebuild, then ' +
          'rerun this suite.',
      );
    });
  });
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Minimal stdio JSON-RPC client. Same shape as tests/mcp-stdio.test.ts but
 * spawns the bundled launcher binary instead of `tsx src/cli/index.ts mcp`.
 */
class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: JsonRpcMessage) => void; reject: (e: Error) => void }
  >();
  private stderr = '';

  constructor(configDir: string) {
    this.child = spawn(BIN, ['mcp'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, MORION_CONFIG_DIR: configDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });

    this.child.on('error', (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) break;
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        const error = new Error(
          `Non-JSON line on bundled MCP stdout: ${line}\nstderr so far:\n${this.stderr}`,
        );
        for (const { reject } of this.pending.values()) reject(error);
        this.pending.clear();
        return;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const handler = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        handler.resolve(msg);
      }
    }
  }

  request(method: string, params: unknown = {}): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
    return new Promise<JsonRpcMessage>((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rejectReq(
            new Error(`bundled MCP request timed out: ${method}\nstderr so far:\n${this.stderr}`),
          );
        }
      }, 20_000);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolveReq(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          rejectReq(err);
        },
      });
      this.child.stdin.write(JSON.stringify(message) + '\n');
    });
  }

  notify(method: string, params: unknown = {}): void {
    const message: JsonRpcMessage = { jsonrpc: '2.0', method, params };
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    if (!this.child.killed) this.child.kill('SIGTERM');
    await new Promise<void>((resolveClose) => {
      if (this.child.exitCode !== null) {
        resolveClose();
        return;
      }
      this.child.once('exit', () => resolveClose());
      setTimeout(() => resolveClose(), 2000).unref();
    });
  }

  getStderr(): string {
    return this.stderr;
  }
}

interface ToolCallContent {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function parseToolResult<T>(msg: JsonRpcMessage): T {
  expect(msg.error).toBeUndefined();
  const result = msg.result as ToolCallContent;
  expect(result).toBeDefined();
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0]!.text) as T;
}

d('packaged binary smoke test', () => {
  let configDir: string;
  let dbPath: string;

  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), 'morion-binsmoke-'));
    dbPath = join(configDir, 'morion.db');
    // Write a config that pins embeddings=noop and a high port so we don't
    // collide with a dev server on 7777.
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify(
        {
          dbPath,
          httpPort: 17802,
          httpHost: '127.0.0.1',
          embeddings: { provider: 'noop', model: 'noop' },
        },
        null,
        2,
      ),
      'utf8',
    );
  });

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('init writes config + applies migrations + loads sqlite-vec', () => {
    // Use a fresh sub-dir so this test doesn't fight the mcp test's DB.
    const initDir = mkdtempSync(join(tmpdir(), 'morion-binsmoke-init-'));
    try {
      const result = spawnSync(BIN, ['init'], {
        env: { ...process.env, MORION_CONFIG_DIR: initDir },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      // The init command logs three lines: wrote, db ready, vec extension loaded.
      // We assert vec=true because the bundled node_modules ships the prebuild
      // and that's the one thing this test really exists to prove.
      expect(result.stdout).toContain('wrote');
      expect(result.stdout).toContain('db ready');
      expect(result.stdout).toContain('vec extension loaded: true');
      expect(existsSync(join(initDir, 'config.json'))).toBe(true);
      expect(existsSync(join(initDir, 'morion.db'))).toBe(true);
    } finally {
      rmSync(initDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('mcp stdio: initialize + tools/list returns every tool in the registry', async () => {
    const client = new StdioMcpClient(configDir);
    try {
      const initResponse = await client.request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'morion-binsmoke', version: '0.0.0' },
      });
      expect(initResponse.error).toBeUndefined();

      client.notify('notifications/initialized');
      await new Promise((r) => setTimeout(r, 50));

      const listResponse = await client.request('tools/list');
      expect(listResponse.error).toBeUndefined();
      const result = listResponse.result as { tools: Array<{ name: string }> };
      // Pin against the live registry — hardcoded 22/27 drifted once, it'll
      // drift again. See R5 2026-04-16.
      expect(result.tools.length).toBe(ALL_TOOLS.length);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('mcp stdio: notes_create writes through the bundled node_modules to SQLite', async () => {
    const client = new StdioMcpClient(configDir);
    try {
      await client.request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'morion-binsmoke', version: '0.0.0' },
      });
      client.notify('notifications/initialized');
      await new Promise((r) => setTimeout(r, 50));

      const created = await client.request('tools/call', {
        name: 'notes_create',
        arguments: { body: '# binary smoke\n\ncreated via the packaged binary' },
      });
      const note = parseToolResult<{ id: string; title: string; body: string }>(created);
      expect(note.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(note.title).toBe('binary smoke');

      // Read straight from disk to prove the binary's better-sqlite3 wrote
      // to the same SQLite file the host's better-sqlite3 can open.
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare('SELECT title, body, source FROM notes WHERE id = ?')
          .get(note.id) as { title: string; body: string; source: string } | undefined;
        expect(row).toBeDefined();
        expect(row!.title).toBe('binary smoke');
        expect(row!.body).toBe('# binary smoke\n\ncreated via the packaged binary');
        expect(row!.source).toBe('mcp:morion-binsmoke');
      } finally {
        db.close();
      }
    } finally {
      await client.close();
    }
  }, 30_000);
});
