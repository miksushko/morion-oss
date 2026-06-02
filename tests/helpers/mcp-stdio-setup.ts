import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';

/**
 * Shared MCP stdio test harness. Spawns the real `tsx src/cli/index.ts
 * mcp` subprocess and gives tests a typed JSON-RPC NDJSON client.
 *
 * Embeddings are forced to `noop` via a temp config.json so tests
 * never download the 120 MB Hugging Face model.
 *
 * Used by tests/mcp-stdio.test.ts — keep the walk in that single file
 * (it relies on declaration-order sequencing across 27 it() blocks,
 * each feeding the next; splitting per-tool-family would require a
 * fresh sidecar + bootstrap per file at the cost of ordering invariants).
 */

const PROJECT_ROOT = resolve(__dirname, '..', '..');
const TSX_BIN = resolve(PROJECT_ROOT, 'node_modules/tsx/dist/cli.mjs');
const CLI_ENTRY = resolve(PROJECT_ROOT, 'src/cli/index.ts');

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: JsonRpcMessage) => void; reject: (e: Error) => void }
  >();
  private stderr = '';

  constructor(configDir: string) {
    this.child = spawn(process.execPath, [TSX_BIN, CLI_ENTRY, 'mcp'], {
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
      } catch (err) {
        // Stray non-JSON line on stdout would corrupt the protocol — fail loudly.
        const error = new Error(
          `Non-JSON line on MCP stdout: ${line}\nstderr so far:\n${this.stderr}`,
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
      // Notifications and unmatched ids are ignored — this client only
      // round-trips request/response pairs.
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
            new Error(
              `MCP request timed out: ${method}\nstderr so far:\n${this.stderr}`,
            ),
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
      // Hard fallback so a broken child doesn't hang the test runner.
      setTimeout(() => resolveClose(), 2000).unref();
    });
  }

  getStderr(): string {
    return this.stderr;
  }
}

export interface ToolCallContent {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export function parseToolResult<T>(msg: JsonRpcMessage): T {
  expect(msg.error).toBeUndefined();
  const result = msg.result as ToolCallContent;
  expect(result).toBeDefined();
  expect(result.isError ?? false).toBe(false);
  expect(result.content).toBeDefined();
  expect(result.content.length).toBeGreaterThan(0);
  expect(result.content[0]?.type).toBe('text');
  return JSON.parse(result.content[0]!.text) as T;
}

/**
 * Create a fresh temp configDir + dbPath with embeddings forced to
 * `noop` (no 120 MB model download in CI). Returns paths the caller
 * passes to `new StdioMcpClient(configDir)` + uses to attach a
 * `better-sqlite3` reader for assertions on the on-disk DB.
 */
export function makeStdioConfigDir(httpPort = 7777): {
  configDir: string;
  dbPath: string;
} {
  const configDir = mkdtempSync(join(tmpdir(), 'morion-stdio-'));
  const dbPath = join(configDir, 'morion.db');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify(
      {
        dbPath,
        httpPort,
        httpHost: '127.0.0.1',
        embeddings: { provider: 'noop', model: 'noop' },
      },
      null,
      2,
    ),
  );
  return { configDir, dbPath };
}
