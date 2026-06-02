import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
// existsSync is also used in isInstalled() above — single import covers both.
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import type { McpServerEntry, MutationResult, ClientStatus } from './types.js';

/**
 * Codex CLI adapter — TOML instead of JSON. Separate module from the
 * generic installer because the codec differs:
 *
 *   ~/.codex/config.toml, section [mcp_servers.morion] with command/args/env.
 *
 * Official docs: https://developers.openai.com/codex/config-basic
 * Important: the section name is `mcp_servers` with underscore. Using
 * hyphen (`mcp-servers`) causes Codex to silently ignore the config —
 * documented in https://github.com/openai/codex/issues/3441.
 *
 * Safety contract mirrors the JSON installer exactly:
 *   1. Refuse on malformed TOML (smol-toml's parser throws on bad input).
 *   2. Touch only mcp_servers.morion — everything else round-trips.
 *   3. Backup with timestamped filename before any write.
 *   4. Atomic rename from .tmp.
 *   5. 2-space indent not applicable for TOML; smol-toml's canonical
 *      output is close enough to human-edited style.
 *
 * Trade-off documented in tasks/todo.md v0.97.0 clients section: TOML
 * comments + field ordering may shift across a round-trip. Backups
 * preserve the exact pre-mutation file so users can diff if needed.
 */

export const CODEX_ADAPTER = {
  id: 'codex',
  displayName: 'Codex CLI',
  configPath(): string {
    return join(homedir(), '.codex', 'config.toml');
  },
  serverKey: 'morion',
  isInstalled(): boolean {
    // Codex CLI creates ~/.codex/ on first run. If absent, the user
    // hasn't run codex on this machine — likely never installed.
    try {
      return existsSync(join(homedir(), '.codex'));
    } catch {
      return false;
    }
  },
};

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

interface ParsedFile {
  exists: boolean;
  root: Record<string, unknown> | null;
  parseError: string | null;
}

function loadToml(path: string): ParsedFile {
  if (!existsSync(path)) return { exists: false, root: null, parseError: null };
  const raw = readFileSync(path, 'utf8');
  if (raw.trim().length === 0) return { exists: true, root: {}, parseError: null };
  try {
    const root = parse(raw) as Record<string, unknown>;
    return { exists: true, root, parseError: null };
  } catch (err) {
    return { exists: true, root: null, parseError: (err as Error).message };
  }
}

function atomicWriteToml(path: string, data: string): string | null {
  mkdirSync(dirname(path), { recursive: true });
  let backupPath: string | null = null;
  if (existsSync(path)) {
    backupPath = `${path}.morion-backup-${nowStamp()}`;
    writeFileSync(backupPath, readFileSync(path));
  }
  const tmpPath = `${path}.morion-tmp-${process.pid}`;
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, path);
  return backupPath;
}

function isCurrentEntry(entry: unknown, expected: McpServerEntry): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as { command?: unknown; args?: unknown };
  if (e.command !== expected.command) return false;
  if (!Array.isArray(e.args)) return false;
  if (e.args.length !== expected.args.length) return false;
  return e.args.every((v, i) => v === expected.args[i]);
}

function codexServers(root: Record<string, unknown>): Record<string, unknown> {
  const existing = root['mcp_servers'];
  if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  return {};
}

export function codexStatus(entry: McpServerEntry): ClientStatus {
  const path = CODEX_ADAPTER.configPath();
  const file = loadToml(path);
  if (!file.exists) return { kind: 'not-installed', reason: 'no-config-file' };
  if (file.root === null) {
    return { kind: 'config-malformed', error: file.parseError ?? 'invalid TOML' };
  }
  const servers = codexServers(file.root);
  const existing = servers[CODEX_ADAPTER.serverKey];
  if (existing === undefined) return { kind: 'not-installed', reason: 'no-entry' };
  if (!isCurrentEntry(existing, entry)) {
    return {
      kind: 'installed-stale',
      entry: {
        command: typeof (existing as { command?: unknown }).command === 'string'
          ? ((existing as { command: string }).command)
          : '',
        args: Array.isArray((existing as { args?: unknown }).args)
          ? ((existing as { args: string[] }).args)
          : [],
      },
    };
  }
  return { kind: 'installed-current', entry };
}

export function codexInstall(entry: McpServerEntry): MutationResult {
  const path = CODEX_ADAPTER.configPath();
  const file = loadToml(path);
  if (file.exists && file.root === null) {
    throw new Error(
      `Refusing to overwrite ${path}: existing TOML is invalid (${file.parseError}). ` +
        `Fix the file by hand or delete it, then try again.`,
    );
  }
  const root = (file.root ?? {}) as Record<string, unknown>;
  const servers = codexServers(root);
  servers[CODEX_ADAPTER.serverKey] = {
    command: entry.command,
    args: entry.args,
  };
  root['mcp_servers'] = servers;
  const out = stringify(root) + '\n';
  const backupPath = atomicWriteToml(path, out);
  return { ok: true, backupPath, configPath: path };
}

export function codexUninstall(): MutationResult {
  const path = CODEX_ADAPTER.configPath();
  const file = loadToml(path);
  if (!file.exists) return { ok: true, backupPath: null, configPath: path };
  if (file.root === null) {
    throw new Error(`Refusing to overwrite ${path}: existing TOML is invalid.`);
  }
  const servers = codexServers(file.root);
  if (!(CODEX_ADAPTER.serverKey in servers)) {
    return { ok: true, backupPath: null, configPath: path };
  }
  delete servers[CODEX_ADAPTER.serverKey];
  file.root['mcp_servers'] = servers;
  const out = stringify(file.root) + '\n';
  const backupPath = atomicWriteToml(path, out);
  return { ok: true, backupPath, configPath: path };
}
