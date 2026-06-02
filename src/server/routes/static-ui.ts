import type { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Serve the built web UI (Vite bundle in `src/web/dist`) in
 * production. Dev (`npm run dev`) relies on Vite's dev server
 * proxying `/api/*` to the sidecar, so this code is a no-op when the
 * dist dir doesn't exist.
 *
 * Registered LAST in `buildHttpApp` so it doesn't shadow any `/api/*`
 * routes.
 */
export function registerStaticUi(app: Hono): void {
  const distRoot = resolveWebDistRoot();
  if (existsSync(join(distRoot, 'index.html'))) {
    // serveStatic from @hono/node-server joins `root` with the
    // request path via path.join, which accepts absolute paths fine.
    // Passing an absolute root means the static handler works no
    // matter what cwd the binary (or `morion serve`, or Tauri
    // sidecar) was launched from.
    app.use('/*', serveStatic({ root: distRoot }));
    app.get('*', serveStatic({ path: join(distRoot, 'index.html') }));
  }
}

/**
 * Locate the Vite-built web bundle (`src/web/dist` in dev, an
 * arbitrary absolute path in a packaged binary).
 *
 * Resolution order:
 *   1. `MORION_WEB_DIST` env var (absolute or cwd-relative). The
 *      packaging story (Tauri sidecar, `bun build --compile`, etc.)
 *      sets this so the bundled UI assets can live anywhere on disk
 *      without code changes.
 *   2. `<this file>/../../web/dist` — `tsx`-loaded source case. From
 *      `src/server/routes/static-ui.ts` this lands at `src/web/dist`.
 *   3. `<this file>/../../../src/web/dist` — compiled
 *      `dist/server/routes/static-ui.js` case. The web bundle stays
 *      at the repo's `src/web/dist` and is *not* copied into
 *      `dist/`, so from the compiled file we have to walk one extra
 *      level up and back into `src`.
 *
 * Resolved once at app build time so we don't re-stat on every
 * request.
 */
function resolveWebDistRoot(): string {
  const envOverride = process.env.MORION_WEB_DIST;
  if (envOverride && envOverride.length > 0) {
    return isAbsolute(envOverride) ? envOverride : resolve(process.cwd(), envOverride);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  // routes/static-ui.ts → up to `src/server/`, then into
  // `src/web/dist`.
  const sourceCandidate = resolve(here, '..', '..', 'web', 'dist');
  if (existsSync(join(sourceCandidate, 'index.html'))) return sourceCandidate;
  return resolve(here, '..', '..', '..', 'src', 'web', 'dist');
}
