import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClientAdapter } from './types.js';

/** Predicate factory: client is installed iff this path exists. Wraps
 * existsSync in a try/catch so a permission-denied stat doesn't crash
 * the whole status endpoint. */
function existsAt(path: string): () => boolean {
  return () => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  };
}

/**
 * Electron-style "userData" dir, used by Claude Desktop, VS Code, Zed, and
 * most Electron apps. Cross-platform by convention:
 *
 *   macOS:   ~/Library/Application Support/
 *   Windows: %APPDATA%\  (= ~\AppData\Roaming\)
 *   Linux:   ~/.config/
 *
 * We avoid leaning on `%APPDATA%` env var alone because some shells (cron,
 * remote SSH, certain test runners) strip it — homedir()-based fallback is
 * reliable on every Windows install.
 */
function appDataDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData && appData.length > 0) return appData;
    return join(homedir(), 'AppData', 'Roaming');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return xdg;
  return join(homedir(), '.config');
}

/**
 * Adapters for the LLM clients we install Morion into automatically.
 *
 * All clients except Zed use the same `{ "mcpServers": { "<key>": ... } }`
 * schema. Zed uses `context_servers` (the adapter's containerKey handles it).
 * Codex lives in its own codec (TOML, not JSON) — see `codex.ts`.
 *
 * Detection rule: each client creates a characteristic directory on first
 * launch. If the dir doesn't exist, the client was never run on this
 * machine — probably never installed. We pick a stable parent dir, not
 * the config file itself: the file may legitimately not exist yet for an
 * installed client (first install, never opened settings), but the parent
 * dir always does after even one launch.
 *
 * Paths are platform-branched: clients that use Electron userData-style
 * storage (Claude Desktop, VS Code/Cline) resolve via `appDataDir()`;
 * clients that anchor on `~/` (Cursor, Claude Code, Codex, Windsurf,
 * Antigravity) share one path across macOS, Linux, and Windows because
 * Node's `homedir()` returns `%USERPROFILE%` on Windows.
 */

const CLAUDE_DESKTOP: ClientAdapter = {
  id: 'claude-desktop',
  displayName: 'Claude Desktop',
  configPath: () => join(appDataDir(), 'Claude', 'claude_desktop_config.json'),
  serverKey: 'morion',
  isInstalled: existsAt(join(appDataDir(), 'Claude')),
};

const CURSOR: ClientAdapter = {
  id: 'cursor',
  displayName: 'Cursor',
  configPath: () => join(homedir(), '.cursor', 'mcp.json'),
  serverKey: 'morion',
  isInstalled: existsAt(join(homedir(), '.cursor')),
};

/**
 * Claude Code stores its global MCP server list in `~/.claude.json`. The
 * file also holds non-MCP fields (UI prefs, project history) — the
 * installer's strict "preserve everything else" rule matters most here.
 *
 * Detection: either the global config file or the per-user config dir.
 * Different Claude Code versions create one or the other first.
 *
 * Path identical on macOS/Linux/Windows — `homedir()` returns
 * `%USERPROFILE%` on Windows.
 */
const CLAUDE_CODE: ClientAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  configPath: () => join(homedir(), '.claude.json'),
  serverKey: 'morion',
  isInstalled: () => {
    try {
      return existsSync(join(homedir(), '.claude.json')) || existsSync(join(homedir(), '.claude'));
    } catch {
      return false;
    }
  },
};

/**
 * Cline ships as a VS Code extension (`saoudrizwan.claude-dev`). Its
 * config lives under VS Code's globalStorage, which is fixed per-extension.
 *
 * Detection: VS Code's User dir + the extension's globalStorage subdir.
 * If either is missing, Cline isn't installed (or VS Code itself isn't).
 *
 * VS Code's userData dir sits under Electron's Electron app-data
 * convention (`appDataDir()/Code`).
 */
const CLINE: ClientAdapter = {
  id: 'cline',
  displayName: 'Cline (VS Code)',
  configPath: () =>
    join(
      appDataDir(),
      'Code',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    ),
  serverKey: 'morion',
  isInstalled: existsAt(
    join(appDataDir(), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),
  ),
};

/**
 * Google Antigravity (agent-first IDE). Config file under ~/.gemini/
 * per the official docs at https://antigravity.google/docs/mcp.
 * Same {mcpServers: {...}} schema as Claude Desktop.
 */
const ANTIGRAVITY: ClientAdapter = {
  id: 'antigravity',
  displayName: 'Google Antigravity',
  configPath: () => join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
  serverKey: 'morion',
  isInstalled: existsAt(join(homedir(), '.gemini', 'antigravity')),
};

/**
 * Zed editor uses a different container key — `context_servers` instead
 * of `mcpServers` — but is otherwise standard JSON with the same entry
 * shape. Our adapter's containerKey field handles it.
 *
 * Zed's settings location differs per platform:
 *   macOS/Linux: `~/.config/zed/settings.json` (Zed uses XDG layout even on macOS)
 *   Windows:     `%APPDATA%\Zed\settings.json`   (standard Electron userData shape)
 */
const ZED: ClientAdapter = {
  id: 'zed',
  displayName: 'Zed',
  configPath: () =>
    process.platform === 'win32'
      ? join(appDataDir(), 'Zed', 'settings.json')
      : join(homedir(), '.config', 'zed', 'settings.json'),
  serverKey: 'morion',
  containerKey: 'context_servers',
  isInstalled: existsAt(
    process.platform === 'win32'
      ? join(appDataDir(), 'Zed')
      : join(homedir(), '.config', 'zed'),
  ),
};

/**
 * Windsurf (Codeium's agent IDE). JSON with mcpServers schema.
 * Path identical on macOS/Linux/Windows — `homedir()` returns
 * `%USERPROFILE%` on Windows.
 */
const WINDSURF: ClientAdapter = {
  id: 'windsurf',
  displayName: 'Windsurf',
  configPath: () => join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
  serverKey: 'morion',
  isInstalled: existsAt(join(homedir(), '.codeium', 'windsurf')),
};

export const ADAPTERS: ClientAdapter[] = [
  CLAUDE_DESKTOP,
  CURSOR,
  CLAUDE_CODE,
  CLINE,
  ANTIGRAVITY,
  ZED,
  WINDSURF,
  // Codex is added separately because it uses TOML, not JSON — see
  // src/core/mcp-install/codex.ts.
];

export function findAdapter(id: string): ClientAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
