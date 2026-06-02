import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ClientAdapter,
  ClientStatus,
  McpServerEntry,
  MutationResult,
} from './types.js';

/**
 * Install / uninstall / status for a Morion entry inside an LLM client's
 * MCP config file.
 *
 * Safety contract — every mutation guarantees:
 *
 *   1. **Never overwrite invalid JSON.** If the file exists but doesn't
 *      parse, we abort with a clear error. The user fixes their file and
 *      tries again. We never blindly replace a config we don't understand.
 *   2. **Never touch unrelated keys.** Read-modify-write only the
 *      `mcpServers.morion` (or equivalent) entry. Every other field —
 *      other MCP servers, UI prefs, project history — is preserved
 *      verbatim, including key order (we re-stringify with stable order
 *      via `JSON.stringify`'s natural object iteration).
 *   3. **Backup before write.** Before any write, copy the existing file
 *      to `<path>.morion-backup-<ISO timestamp>`. The backup path is
 *      returned so the UI can show "rolled back from <path>" in toasts.
 *      If the file didn't exist beforehand, no backup is needed.
 *   4. **Atomic write.** Write to `<path>.morion-tmp-<pid>`, then rename
 *      onto the final path. Power loss mid-write either leaves the old
 *      file intact or the new one — never a half-written one.
 *   5. **Pretty-print, 2-space indent, trailing newline.** So humans
 *      diff-checking the file see a clean change.
 */

const CONTAINER_DEFAULT = 'mcpServers';

function nowStamp(): string {
  // ISO-ish but fs-friendly: 2026-04-14T15-23-09-512Z
  return new Date().toISOString().replace(/[:.]/g, '-');
}

interface FileState {
  exists: boolean;
  /** Parsed JSON if valid, else null + parseError set. */
  parsed: Record<string, unknown> | null;
  parseError: string | null;
}

function loadFile(path: string): FileState {
  if (!existsSync(path)) {
    return { exists: false, parsed: null, parseError: null };
  }
  const raw = readFileSync(path, 'utf8');
  if (raw.trim().length === 0) {
    // Empty file is treated as if it didn't exist — safe to replace.
    return { exists: true, parsed: {}, parseError: null };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { exists: true, parsed: null, parseError: 'config root is not a JSON object' };
    }
    return { exists: true, parsed: parsed as Record<string, unknown>, parseError: null };
  } catch (err) {
    return { exists: true, parsed: null, parseError: (err as Error).message };
  }
}

/**
 * Atomic-write `data` to `path`, with a backup of the existing file if
 * any. Returns the backup path (null if the file didn't exist).
 */
function atomicWrite(path: string, data: string): string | null {
  mkdirSync(dirname(path), { recursive: true });
  let backupPath: string | null = null;
  if (existsSync(path)) {
    backupPath = `${path}.morion-backup-${nowStamp()}`;
    const original = readFileSync(path);
    writeFileSync(backupPath, original);
  }
  const tmpPath = `${path}.morion-tmp-${process.pid}`;
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, path);
  return backupPath;
}

function containerOf(adapter: ClientAdapter): string {
  return adapter.containerKey ?? CONTAINER_DEFAULT;
}

function entryEquals(a: McpServerEntry, b: McpServerEntry): boolean {
  if (a.command !== b.command) return false;
  if (a.args.length !== b.args.length) return false;
  return a.args.every((v, i) => v === b.args[i]);
}

/** Read-only — never modifies the file. */
export function status(adapter: ClientAdapter, currentEntry: McpServerEntry): ClientStatus {
  const path = adapter.configPath();
  const file = loadFile(path);
  if (!file.exists) return { kind: 'not-installed', reason: 'no-config-file' };
  if (file.parsed === null)
    return { kind: 'config-malformed', error: file.parseError ?? 'unknown parse error' };

  const containerKey = containerOf(adapter);
  const container = file.parsed[containerKey];
  if (typeof container !== 'object' || container === null || Array.isArray(container)) {
    return { kind: 'not-installed', reason: 'no-entry' };
  }
  const entry = (container as Record<string, unknown>)[adapter.serverKey];
  if (entry === undefined) return { kind: 'not-installed', reason: 'no-entry' };

  // Validate the entry shape. Unknown shape → treat as stale (so the
  // user can overwrite it with a fresh install). We don't surface
  // "config-malformed" here because the file as a whole is fine; only
  // our entry is unexpected.
  if (
    typeof entry !== 'object' ||
    entry === null ||
    typeof (entry as { command?: unknown }).command !== 'string' ||
    !Array.isArray((entry as { args?: unknown }).args)
  ) {
    return { kind: 'installed-stale', entry: { command: '', args: [] } };
  }
  const e = entry as McpServerEntry;
  return entryEquals(e, currentEntry)
    ? { kind: 'installed-current', entry: e }
    : { kind: 'installed-stale', entry: e };
}

/**
 * Upsert the morion entry. Refuses if the existing file is malformed.
 * Idempotent — calling install twice with the same `entry` is a no-op
 * file-wise (we still write to bump mtime + backup, since this is what
 * the user explicitly asked for).
 */
export function install(adapter: ClientAdapter, entry: McpServerEntry): MutationResult {
  const path = adapter.configPath();
  const file = loadFile(path);

  if (file.exists && file.parsed === null) {
    throw new Error(
      `Refusing to overwrite ${path}: existing JSON is invalid (${file.parseError}). ` +
        `Fix the file by hand or delete it, then try again.`,
    );
  }

  const root: Record<string, unknown> = file.parsed ?? {};
  const containerKey = containerOf(adapter);
  const existing = root[containerKey];
  const container: Record<string, unknown> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  container[adapter.serverKey] = entry;
  root[containerKey] = container;

  const json = JSON.stringify(root, null, 2) + '\n';
  const backupPath = atomicWrite(path, json);
  return { ok: true, backupPath, configPath: path };
}

/**
 * Remove only our entry. If the entry doesn't exist, return ok:true with
 * no backup (no-op). Never deletes the file even if our entry was the
 * last one — the empty container stays so the user's editor diff stays
 * minimal.
 */
export function uninstall(adapter: ClientAdapter): MutationResult {
  const path = adapter.configPath();
  const file = loadFile(path);
  if (!file.exists) return { ok: true, backupPath: null, configPath: path };
  if (file.parsed === null) {
    throw new Error(
      `Refusing to overwrite ${path}: existing JSON is invalid (${file.parseError}).`,
    );
  }

  const containerKey = containerOf(adapter);
  const container = file.parsed[containerKey];
  if (typeof container !== 'object' || container === null || Array.isArray(container)) {
    return { ok: true, backupPath: null, configPath: path };
  }
  const containerObj = container as Record<string, unknown>;
  if (!(adapter.serverKey in containerObj)) {
    return { ok: true, backupPath: null, configPath: path };
  }
  delete containerObj[adapter.serverKey];

  const json = JSON.stringify(file.parsed, null, 2) + '\n';
  const backupPath = atomicWrite(path, json);
  return { ok: true, backupPath, configPath: path };
}

/**
 * Build the entry to write. Prefers the bundled launcher (prod .app);
 * falls back to a `npm run mcp` shape with cwd for dev. The dev shape
 * isn't exposed via the install endpoints in v0.96.0 (we want users
 * pointing their LLM clients at the prod app, not at a dev session that
 * may not be running) — but the helper is here for the CLI and for tests.
 */
export function entryForLauncher(launcherPath: string): McpServerEntry {
  return { command: launcherPath, args: ['mcp'] };
}

export function entryForDev(repoCwd: string): McpServerEntry {
  return { command: 'npm', args: ['run', 'mcp', '--silent', '--prefix', repoCwd] };
}

/** Internal helper exposed for testing. Don't use in production code. */
export const _internal = { loadFile, atomicWrite, nowStamp };
