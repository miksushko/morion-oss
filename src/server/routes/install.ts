import type { Hono } from 'hono';
import { ADAPTERS, findAdapter } from '../../core/mcp-install/adapters.js';
import {
  install,
  uninstall,
  status,
  entryForLauncher,
} from '../../core/mcp-install/installer.js';
import {
  CODEX_ADAPTER,
  codexInstall,
  codexUninstall,
  codexStatus,
} from '../../core/mcp-install/codex.js';

/**
 * One-click install/uninstall of the Morion entry into known LLM client
 * config files. The installer in `src/core/mcp-install/` enforces the
 * safety contract (atomic, backup-before-write, never overwrite invalid
 * JSON, never touch unrelated keys). These endpoints are thin glue.
 *
 * The current launcher path comes from `process.argv[1]` resolved
 * relative to the bundled CLI layout — same logic that drives
 * `/api/runtime`'s `launcherPath`. In dev (no `.app`) the install
 * endpoints return 503 — we refuse to wire a user's external LLM
 * client at a dev session that may not be running. CLI from inside
 * the `.app` is the supported path.
 *
 * `/api/install/:id` also gates on per-adapter `isInstalled()` (v0.97.1)
 * so clicking Connect for a client the user doesn't actually have
 * returns 409 with the client's display name instead of silently
 * creating a phantom config dir.
 */
function currentLauncherPath(): string | null {
  // The package-bin sidecar layout always puts the CLI entry at
  // `…/app/cli/index.js`, regardless of platform. Dev mode (npm run
  // dev / tsx) launches a path that doesn't match this shape, so the
  // regex no-match is the dev signal — works for every platform
  // without special-casing macOS via `.app/Contents/`. Same gate
  // shape that `/api/runtime` `isBundled` uses (system.ts).
  const scriptPath = process.argv[1] ?? '';
  // Normalise backslashes → forward slashes so the regex matches on
  // Windows where `process.argv[1]` is `C:\Users\...\app\cli\index.js`.
  const scriptNorm = scriptPath.replace(/\\/g, '/');
  const m = scriptNorm.match(/^(.*)\/app\/cli\/index\.(?:js|mjs|cjs)$/);
  if (!m) return null;
  const base = m[1];
  // Per-platform launcher inside the sidecar tree:
  //   macOS / Linux: bash shim `morion`
  //   Windows:       batch shim `morion.cmd`
  // Emit native separators on Windows so a user pasting the path into
  // Claude Desktop / Cursor / Codex configs gets a valid JSON-stringified
  // Windows path (the installer's atomic-write step calls JSON.stringify
  // which escapes the backslashes correctly).
  if (process.platform === 'win32') {
    return `${base}/morion.cmd`.replace(/\//g, '\\');
  }
  return `${base}/morion`;
}

export function registerInstallRoutes(app: Hono): void {
  app.get('/api/install/clients', (c) => {
    const launcher = currentLauncherPath();
    if (launcher === null) {
      return c.json({
        bundled: false,
        message:
          'Auto-install is only available in the installed Morion.app. ' +
          'Build/install the .app, then open Settings there.',
        clients: [
          ...ADAPTERS.map((a) => ({ id: a.id, displayName: a.displayName })),
          { id: CODEX_ADAPTER.id, displayName: CODEX_ADAPTER.displayName },
        ],
      });
    }
    const entry = entryForLauncher(launcher);
    return c.json({
      bundled: true,
      launcherPath: launcher,
      clients: [
        ...ADAPTERS.map((a) => ({
          id: a.id,
          displayName: a.displayName,
          configPath: a.configPath(),
          status: status(a, entry),
          // Adapter without a detector is treated as installed
          // (fail-open) — preserves backward compat with adapters
          // someone might add without thinking about detection.
          installed: a.isInstalled ? a.isInstalled() : true,
        })),
        {
          id: CODEX_ADAPTER.id,
          displayName: CODEX_ADAPTER.displayName,
          configPath: CODEX_ADAPTER.configPath(),
          status: codexStatus(entry),
          installed: CODEX_ADAPTER.isInstalled(),
        },
      ],
    });
  });

  app.post('/api/install/:id', async (c) => {
    const launcher = currentLauncherPath();
    if (launcher === null) {
      return c.json({ error: 'auto-install requires the bundled .app' }, 503);
    }
    const id = c.req.param('id');
    const entry = entryForLauncher(launcher);
    // Server-side guard: refuse to write a config file for a client
    // that isn't installed on this machine. Without this, clicking
    // Connect for a client the user doesn't have creates phantom dirs
    // in $HOME (e.g. ~/.codeium/windsurf/) and pretends to "succeed".
    try {
      if (id === CODEX_ADAPTER.id) {
        if (!CODEX_ADAPTER.isInstalled()) {
          return c.json({ error: `${CODEX_ADAPTER.displayName} is not installed on this machine` }, 409);
        }
        return c.json(codexInstall(entry));
      }
      const adapter = findAdapter(id);
      if (!adapter) return c.json({ error: 'unknown client id' }, 404);
      if (adapter.isInstalled && !adapter.isInstalled()) {
        return c.json({ error: `${adapter.displayName} is not installed on this machine` }, 409);
      }
      return c.json(install(adapter, entry));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 422);
    }
  });

  app.delete('/api/install/:id', (c) => {
    const id = c.req.param('id');
    try {
      if (id === CODEX_ADAPTER.id) return c.json(codexUninstall());
      const adapter = findAdapter(id);
      if (!adapter) return c.json({ error: 'unknown client id' }, 404);
      return c.json(uninstall(adapter));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 422);
    }
  });
}
