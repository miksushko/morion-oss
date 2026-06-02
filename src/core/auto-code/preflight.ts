import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findAdapter } from '../mcp-install/adapters.js';
import { status as mcpStatus } from '../mcp-install/installer.js';
import { codexStatus } from '../mcp-install/codex.js';
import type { McpServerEntry } from '../mcp-install/types.js';

/**
 * Auto-code Phase 1 — environment pre-flight check
 * (sub-ticket 01KQEEARKNH9TE8D008WAX7PQ7, umbrella
 * 01KQANTZDKW6QH461AK2JN3DCQ).
 *
 * Inspects the user's machine to decide whether the auto-code loop
 * can actually run for them. Read-only — no installs, no writes.
 *
 * Blocking criteria (umbrella step 2 — "проверка [при включении]"):
 *
 *   - Claude binary must exist + run `--version`. Without Claude
 *     there's no fix runner; Codex-only is not a supported mode in
 *     v0.1 (umbrella: "приоритет всегда Клоду").
 *   - Morion MCP must be wired into Claude's config. Mo can't pass
 *     context to the agent without an MCP transport.
 *
 * Non-blocking warnings:
 *
 *   - Codex binary missing → review falls back to a second Claude
 *     session (#5 launcher handles the fallback).
 *   - Morion MCP missing in Codex config → only matters if Codex
 *     binary IS present.
 *
 * Skills are deliberately NOT auto-detected here. Codex installs
 * skills only at the project level (no stable user-level path), and
 * the Claude install flow lives in the parallel sub-ticket
 * `01KQATCMZ5AHY26W1C3M0ZGHG3` (Settings → Skills installer). The
 * UI surfaces a static "Skills required" reminder instead, with a
 * pointer to that installer. Avoids drift between the preflight
 * check and the install flow as Skills format / paths evolve.
 */

/** Lazy path lookups — computed per call so tests can override
 *  `$HOME` without restarting the module (homedir() reads $HOME on
 *  every call). Module-level constants would freeze the dev shell's
 *  home and make the temp-HOME pattern in tests silently no-op. */
const vscodeExtensionsDir = (): string =>
  join(homedir(), '.vscode', 'extensions');
const desktopVmDir = (): string =>
  join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-vm');

export interface BinaryStatus {
  /** True when the binary was located AND `--version` produced output
   *  without throwing. */
  ready: boolean;
  /** Absolute path to the resolved binary, or null when nothing
   *  worked. Useful for the launcher in #4 — we don't re-run the
   *  detection per spawn. */
  path: string | null;
  /** Where we found it: `path` (PATH lookup), `vscode-extension`
   *  (~/.vscode/extensions/anthropic.claude-code-*),
   *  `desktop-app-vm` (~/Library/Application Support/Claude/...).
   *  null when not found. */
  source: 'path' | 'vscode-extension' | 'desktop-app-vm' | null;
  /** Human-readable error if we tried but failed. null when ready
   *  (or when we never got far enough to error). */
  error: string | null;
}

export interface McpInstallStatus {
  /** True when the user's config contains a `morion` server entry,
   *  regardless of whether the entry's command path matches our
   *  current bundled launcher. The installer route handles the
   *  current-vs-stale distinction for upgrade prompts; preflight
   *  cares only about presence. */
  installed: boolean;
  /** Where we looked. Useful for the UI tooltip + the install
   *  button's "Open config" affordance. */
  configPath: string;
  /** Set when the file exists but failed to parse — the user must
   *  fix it by hand (the installer also refuses to overwrite
   *  malformed configs). */
  error: string | null;
}

export interface PreflightResult {
  claude: BinaryStatus;
  codex: BinaryStatus;
  mcp: {
    claude: McpInstallStatus;
    codex: McpInstallStatus;
  };
  /** Human-readable reasons the auto-code toggle should refuse to
   *  flip to ON. Empty array = environment is good (the UI may still
   *  block on linked-repo / Mo-not-enabled gates from #1, which are
   *  separate concerns). */
  blocking: string[];
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

/**
 * Walk `process.env.PATH` and return the first directory containing
 * an executable matching `binName`. Falls back to a curated list of
 * common dev-install directories that the Tauri-launched sidecar's
 * inherited PATH typically misses (Homebrew on Apple Silicon, nvm,
 * cargo, bun, etc.). Returns null when no match. We don't shell out
 * to `which` so this works on Windows too.
 *
 * Why the fallback list (Morion ticket 01KRRXA0CWNJWBBX21XCFWXZ7E):
 * macOS desktop apps launched from Finder inherit a minimal launchd
 * PATH (`/usr/bin:/bin:/usr/sbin:/sbin` + cryptex bits). The user's
 * login-shell additions (`/opt/homebrew/bin`, `~/.nvm/.../bin`, etc.)
 * are NOT in that PATH, so `pi` / `claude` / `codex` installed via
 * Homebrew or nvm look "missing" to the sidecar even though `which
 * pi` works fine from the terminal. Probe the well-known dirs as a
 * second pass; on Windows + Linux nothing extra fires (the fallback
 * list is darwin-only — Linux desktop envs export PATH correctly).
 */
function findOnPath(binName: string): string | null {
  // Windows binaries usually live without an extension under WSL/git-bash
  // but ship with .exe / .cmd on plain cmd. Try the bare name first;
  // expand to .exe / .cmd on Windows only if that misses.
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  const path = process.env.PATH ?? '';
  const pathCandidates = path ? path.split(delimiter) : [];
  for (const dir of pathCandidates) {
    if (!dir) continue;
    const hit = probeDirForBinary(dir, binName, exts);
    if (hit) return hit;
  }
  // Fallback: well-known dev-install dirs the sidecar's PATH often
  // misses. Computed lazily per call so tests overriding $HOME work.
  for (const dir of devFallbackDirs()) {
    const hit = probeDirForBinary(dir, binName, exts);
    if (hit) return hit;
  }
  return null;
}

/** Exported for unit testing (Morion ticket 01KRRXA0CWNJWBBX21XCFWXZ7E).
 *  Production callers reach this via `findOnPath` only. */
export function _findOnPathForTest(binName: string): string | null {
  return findOnPath(binName);
}

function probeDirForBinary(
  dir: string,
  binName: string,
  exts: readonly string[],
): string | null {
  for (const ext of exts) {
    const candidate = join(dir, binName + ext);
    try {
      if (existsSync(candidate)) {
        const st = statSync(candidate);
        if (st.isFile()) return candidate;
      }
    } catch {
      // permission errors etc. are silently skipped — try the next dir.
    }
  }
  return null;
}

/**
 * Well-known dev-install dirs to probe when `process.env.PATH` misses
 * a binary. Darwin-only — Linux desktop envs export PATH correctly via
 * `~/.profile` / systemd-user.
 *
 * Order matters: Homebrew first (most common on macOS), then per-user
 * package managers in rough popularity order. For nvm we pick the
 * highest-versioned node dir (ASCII sort then reverse — same shape as
 * the existing claude-via-vscode resolver).
 */
function devFallbackDirs(): string[] {
  if (process.platform !== 'darwin') return [];
  const home = homedir();
  const fixed = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, 'go', 'bin'),
  ];
  const nvm = latestNvmBinDir(home);
  return nvm ? [...fixed, nvm] : fixed;
}

/** Latest installed node version dir under `~/.nvm/versions/node/`,
 *  or null when nvm isn't installed / no versions present. */
function latestNvmBinDir(home: string): string | null {
  const root = join(home, '.nvm', 'versions', 'node');
  if (!existsSync(root)) return null;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  // ASCII sort then reverse — version dirs look like `v25.8.1` and
  // sort lexicographically the way semver does for fixed-width
  // segments. Good enough; correctness depends on the user not
  // having both v9.x and v10.x installed (rare in nvm-driven setups).
  const versions = entries.filter((e) => e.startsWith('v')).sort().reverse();
  for (const v of versions) {
    const bin = join(root, v, 'bin');
    if (existsSync(bin)) return bin;
  }
  return null;
}

/**
 * Spike-confirmed Claude Code CLI ships through the VS Code
 * extension as a native arm64 binary (macOS) plus a Linux ELF binary
 * inside the desktop app's containerised VM (which we can't run on
 * the macOS host). Pick the LATEST versioned extension dir and
 * return its native-binary path.
 */
function findClaudeViaVscode(): string | null {
  if (!existsSync(vscodeExtensionsDir())) return null;
  let entries: string[];
  try {
    entries = readdirSync(vscodeExtensionsDir());
  } catch {
    return null;
  }
  const platformTag =
    process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'darwin-arm64'
        : 'darwin-x64'
      : process.platform === 'win32'
        ? 'win32-x64'
        : 'linux-x64';
  const matches = entries
    .filter((e) =>
      e.startsWith('anthropic.claude-code-') && e.endsWith(`-${platformTag}`),
    )
    // Newest version first by ASCII sort — semver-ish, good enough
    // because the version segment is fixed-width "X.Y.ZZZ".
    .sort()
    .reverse();
  for (const dir of matches) {
    const candidate = join(
      vscodeExtensionsDir(),
      dir,
      'resources',
      'native-binary',
      process.platform === 'win32' ? 'claude.exe' : 'claude',
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Last resort on macOS: the desktop app ships a Linux ARM64 ELF
 * binary in `~/Library/Application Support/Claude/claude-code-vm/<ver>/claude`
 * for use inside its containerised VM. We CAN'T run it directly on
 * macOS host (the spike confirmed `exec format error`), so we skip
 * this branch on macOS but keep the logic for Linux ARM64 hosts where
 * the same binary IS executable.
 */
function findClaudeViaDesktopVm(): string | null {
  if (process.platform === 'darwin') return null;
  if (!existsSync(desktopVmDir())) return null;
  let versions: string[];
  try {
    versions = readdirSync(desktopVmDir());
  } catch {
    return null;
  }
  versions.sort().reverse();
  for (const v of versions) {
    const candidate = join(desktopVmDir(), v, 'claude');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface DetectOptions {
  /** Inject candidate paths to short-circuit lookup — primarily for
   *  tests that don't want to hit the real filesystem. */
  preferPath?: string;
}

export function detectClaudeBin(opts: DetectOptions = {}): BinaryStatus {
  const candidates: Array<{ path: string; source: BinaryStatus['source'] }> = [];
  if (opts.preferPath) candidates.push({ path: opts.preferPath, source: 'path' });
  const onPath = findOnPath('claude');
  if (onPath) candidates.push({ path: onPath, source: 'path' });
  const viaVscode = findClaudeViaVscode();
  if (viaVscode) candidates.push({ path: viaVscode, source: 'vscode-extension' });
  const viaDesktop = findClaudeViaDesktopVm();
  if (viaDesktop) candidates.push({ path: viaDesktop, source: 'desktop-app-vm' });
  for (const c of candidates) {
    const probe = probeBinary(c.path);
    if (probe.ok) {
      return { ready: true, path: c.path, source: c.source, error: null };
    }
    // Keep walking — a stale candidate (e.g. linux ELF on macOS,
    // exec-format-error from the spike) shouldn't poison the result.
  }
  return {
    ready: false,
    path: null,
    source: null,
    error:
      candidates.length === 0
        ? 'Claude Code CLI not found. Install from claude.ai/code or via the VS Code extension.'
        : 'Claude binary located but `--version` failed — likely an architecture mismatch.',
  };
}

/**
 * Codex CLI detection.
 *
 * We DON'T gate `ready` on auth state here — there are multiple
 * working configurations (newer Rust codex with `auth.json`
 * chatgpt-OAuth, Node 0.1.x with OPENAI_API_KEY, future Rust
 * versions, etc.) and discriminating between them at preflight time
 * is fragile. Instead the codex-launcher detects the "Ink crashes
 * in non-TTY → exit 0 + empty stdout" failure mode at SPAWN time
 * and the orchestrator transparently falls back to claude-fallback
 * for that ticket.
 *
 * Background: codex 0.1.x (the Node-based CLI installed via
 * `npm i -g @openai/codex`) renders an interactive Ink UI for
 * first-run auth ("Sign in with ChatGPT, or paste an API key")
 * even when invoked with `-q`. The user's `auth.json` with
 * `auth_mode: chatgpt` is honoured ONLY by the newer Rust codex CLI
 * — Node 0.1.x ignores it. So a user with ChatGPT-OAuth-only auth
 * + Node codex installed will see codex spawn cleanly via
 * `--version` but emit nothing on actual review prompts. Hence the
 * runtime fallback rather than a preflight gate.
 */
export function detectCodexBin(opts: DetectOptions = {}): BinaryStatus {
  if (opts.preferPath) {
    const probe = probeBinary(opts.preferPath);
    if (probe.ok) {
      return { ready: true, path: opts.preferPath, source: 'path', error: null };
    }
  }
  const onPath = findOnPath('codex');
  if (onPath) {
    const probe = probeBinary(onPath);
    if (probe.ok) {
      return { ready: true, path: onPath, source: 'path', error: null };
    }
    return {
      ready: false,
      path: null,
      source: null,
      error: 'Codex binary located but `--version` failed.',
    };
  }
  return {
    ready: false,
    path: null,
    source: null,
    error: 'Codex CLI not found on PATH (optional — Claude can do review fallback).',
  };
}

/**
 * Pi CLI detection. Same shape as codex — PATH lookup + `--version`
 * probe. Pi runs OSS / hosted models against arbitrary providers
 * (Ollama by default), the binary itself just needs to be invokable.
 * Optional in the workspace; only the `pi-fix` template (and future
 * pi-* templates) gate on it.
 */
export function detectPiBin(opts: DetectOptions = {}): BinaryStatus {
  return detectGenericBin('pi', opts);
}

/**
 * Opencode CLI detection. Mirrors codex/pi shape. Optional; gated
 * only by future opencode-* templates.
 */
export function detectOpencodeBin(opts: DetectOptions = {}): BinaryStatus {
  return detectGenericBin('opencode', opts);
}

function detectGenericBin(
  binName: string,
  opts: DetectOptions = {},
): BinaryStatus {
  if (opts.preferPath) {
    const probe = probeBinary(opts.preferPath);
    if (probe.ok) {
      return { ready: true, path: opts.preferPath, source: 'path', error: null };
    }
  }
  const onPath = findOnPath(binName);
  if (onPath) {
    const probe = probeBinary(onPath);
    if (probe.ok) {
      return { ready: true, path: onPath, source: 'path', error: null };
    }
    return {
      ready: false,
      path: null,
      source: null,
      error: `${binName} binary located but \`--version\` failed.`,
    };
  }
  return {
    ready: false,
    path: null,
    source: null,
    error: `${binName} CLI not found on PATH.`,
  };
}

function probeBinary(absPath: string): { ok: true; output: string } | { ok: false; error: string } {
  try {
    const out = execFileSync(absPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    });
    return { ok: true, output: out.trim() };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? String(err) };
  }
}

// ---------------------------------------------------------------------------
// MCP config detection — reuse the existing installer adapters so the
// detection logic stays consistent with the install/uninstall flow.
// ---------------------------------------------------------------------------

const DUMMY_ENTRY: McpServerEntry = { command: '', args: [] };

export function detectMorionMcpInClaude(): McpInstallStatus {
  const adapter = findAdapter('claude-code');
  if (!adapter) {
    return {
      installed: false,
      configPath: '(unknown)',
      error: 'internal: claude-code adapter missing',
    };
  }
  const path = adapter.configPath();
  const result = mcpStatus(adapter, DUMMY_ENTRY);
  switch (result.kind) {
    case 'installed-current':
    case 'installed-stale':
      return { installed: true, configPath: path, error: null };
    case 'config-malformed':
      return { installed: false, configPath: path, error: result.error };
    case 'not-installed':
      return { installed: false, configPath: path, error: null };
  }
}

export function detectMorionMcpInCodex(): McpInstallStatus {
  const result = codexStatus(DUMMY_ENTRY);
  const path = join(homedir(), '.codex', 'config.toml');
  switch (result.kind) {
    case 'installed-current':
    case 'installed-stale':
      return { installed: true, configPath: path, error: null };
    case 'config-malformed':
      return { installed: false, configPath: path, error: result.error };
    case 'not-installed':
      return { installed: false, configPath: path, error: null };
  }
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/**
 * Lightweight per-agent availability check. Used by the workflow
 * orchestrator + UI dropdown to decide whether a template's required
 * agents are all installed BEFORE claiming a workflow_runs row.
 *
 * Returns a flat record so callers can render UI tooltips / build
 * blocking messages from the same source. The keys mirror
 * `CliAgentName` from the workflow types.
 */
export interface AgentAvailability {
  claude: BinaryStatus;
  codex: BinaryStatus;
  pi: BinaryStatus;
  opencode: BinaryStatus;
}

/**
 * Module-level cache for `detectAgentAvailability`. Each
 * `detect*Bin` call shells out to `<bin> --version` via
 * `execFileSync` with a 5-second timeout — installing 4 binaries
 * routinely costs hundreds of ms in aggregate, and a hanging
 * binary (a slow wrapper, an unresponsive shim) can stretch
 * into multi-second probes. The list endpoint + the templates
 * endpoint both probe on every call, which compounded the
 * latency the user observed when opening the auto-code popup.
 *
 * 30 seconds is the right sweet-spot: long enough to cover the
 * popup-open burst (settings + workflows fetches usually fire
 * within seconds of each other), short enough that
 * `brew install pi` mid-session shows up the next time the
 * user re-renders. Tests can opt out by passing `force: true`.
 */
const AVAILABILITY_TTL_MS = 30_000;
let _availabilityCache: { value: AgentAvailability; ts: number } | null = null;

export function detectAgentAvailability(opts?: {
  force?: boolean;
}): AgentAvailability {
  if (
    !opts?.force &&
    _availabilityCache &&
    Date.now() - _availabilityCache.ts < AVAILABILITY_TTL_MS
  ) {
    return _availabilityCache.value;
  }
  const value: AgentAvailability = {
    claude: detectClaudeBin(),
    codex: detectCodexBin(),
    pi: detectPiBin(),
    opencode: detectOpencodeBin(),
  };
  _availabilityCache = { value, ts: Date.now() };
  return value;
}

/** Clear the cache. Used by tests + by ops paths that want a
 *  fresh probe (e.g. after the user installs a binary inline). */
export function _resetAgentAvailabilityCache(): void {
  _availabilityCache = null;
}

export function runPreflight(): PreflightResult {
  const claude = detectClaudeBin();
  const codex = detectCodexBin();
  const mcpClaude = detectMorionMcpInClaude();
  const mcpCodex = detectMorionMcpInCodex();

  const blocking: string[] = [];
  if (!claude.ready) {
    blocking.push(
      claude.error ??
        'Claude Code CLI is required to run the auto-code loop.',
    );
  }
  if (!mcpClaude.installed) {
    blocking.push(
      mcpClaude.error
        ? `Claude MCP config is malformed (${mcpClaude.error}). Fix it before enabling auto-code.`
        : 'Morion MCP is not installed in Claude Code. Install it from Settings → Connect Apps.',
    );
  }

  return {
    claude,
    codex,
    mcp: { claude: mcpClaude, codex: mcpCodex },
    blocking,
  };
}
