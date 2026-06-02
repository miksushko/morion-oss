import type { Hono } from 'hono';
import type { ToolContext } from '../tools/types.js';
import { APP_VERSION } from '../../core/version.js';

/**
 * System endpoints — health probe, notebook status, runtime metadata.
 *
 * `/api/health` is the only endpoint exempt from the auth gate; the
 * Rust shell uses it to wait for sidecar readiness before the token
 * IPC resolves. See `../middleware/auth.ts`.
 *
 * `/api/runtime` tells the UI whether it's running inside a bundled
 * `.app` (so Settings can render prod MCP snippets) or a dev session
 * (render the `npm run mcp` snippet instead). Also returns
 * `launcherPath` — the bash launcher path inside the `.app` tree — so
 * the UI can paste absolute paths into Claude Desktop / Cursor / etc.
 * configs.
 */
export function registerSystemRoutes(
  app: Hono,
  ctxBase: Omit<ToolContext, 'actor'>,
): void {
  app.get('/api/health', (c) => c.json({ ok: true, version: APP_VERSION }));

  app.get('/api/status', (c) =>
    c.json({
      ok: true,
      notesCount: (
        ctxBase.notes as unknown as {
          list: (f: { limit: number; offset: number }) => unknown[];
        }
      ).list({ limit: 500, offset: 0 }).length,
    }),
  );

  // Runtime info for the "Connect an LLM client" card. The UI uses
  // these values to render copy-pasteable JSON snippets for Claude
  // Desktop / Cursor / Cline / Zed without the user having to know
  // where the binary lives.
  //
  // `isBundled` distinguishes the prod sidecar (running inside
  // Morion.app) from a dev invocation (tsx / node from source). Prod
  // points clients at the bash launcher inside the `.app`; dev points
  // them at `npm run mcp` in the repo.
  //
  // `launcherPath` is derived from scriptPath: the package-bin layout
  // places the launcher two directories above the CLI entry, so for a
  // scriptPath of `<...>/sidecar/app/cli/index.js` the launcher lives
  // at `<...>/sidecar/morion`.
  app.get('/api/runtime', (c) => {
    const execPath = process.execPath;
    const scriptPath = process.argv[1] ?? null;
    // Bundled detection works off two signals:
    //   macOS:   execPath inside `.app/Contents/` — authoritative
    //   Windows/Linux: scriptPath ends in `…/app/cli/index.js`, which
    //            is the package-bin sidecar layout (dist-bin/app/cli/).
    //            Dev mode runs `tsx src/cli/index.ts`, so the path
    //            shape differs.
    const macBundled = execPath.includes('.app/Contents/');
    // Normalise separators so this check works on Windows (which emits
    // `…\app\cli\index.js`) AND macOS/Linux (`…/app/cli/index.js`).
    const scriptNorm = scriptPath ? scriptPath.replace(/\\/g, '/') : null;
    const sidecarBundled =
      scriptNorm !== null &&
      /\/app\/cli\/index\.(?:js|mjs|cjs)$/.test(scriptNorm);
    const isBundled = macBundled || sidecarBundled;
    let launcherPath: string | null = null;
    if (isBundled && scriptNorm) {
      const match = scriptNorm.match(/^(.*)\/app\/cli\/index\.(?:js|mjs|cjs)$/);
      if (match) {
        // The per-platform launcher: bash shim on macOS/Linux, batch
        // shim on Windows. `scripts/package-bin.mjs` emits both from
        // a shared template.
        const base = match[1];
        const launcherName = process.platform === 'win32' ? 'morion.cmd' : 'morion';
        // Emit with native separators on Windows so a user copy-pasting
        // the path into `claude_desktop_config.json` gets a valid string.
        launcherPath =
          process.platform === 'win32'
            ? `${base}\\${launcherName}`.replace(/\//g, '\\')
            : `${base}/${launcherName}`;
      }
    }
    return c.json({
      execPath,
      scriptPath,
      isBundled,
      launcherPath,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
    });
  });
}
