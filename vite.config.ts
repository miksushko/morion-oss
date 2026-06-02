import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

// Vite roots the web app at src/web so index.html lives next to its entry.
// The built bundle lands in src/web/dist, which hono serves statically in
// production (see src/server/http.ts).
export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  // Relative base so asset paths in index.html are ./assets/... instead of
  // /assets/... — required for tauri://localhost where absolute paths fail.
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Dev backend deliberately on a NON-7777 port so a running prod
      // Morion.app (which binds 7777) can't be silently proxied to. Vite's
      // proxy doesn't probe the target — without this, an EADDRINUSE on
      // dev:server makes Vite forward /api/* to whatever's actually on
      // 7777, which is your installed app's sidecar with the prod DB.
      // npm run dev:server reads MORION_HTTP_PORT and binds 7778 to match.
      '/api': {
        target: 'http://127.0.0.1:7778',
        ws: true,
      },
    },
  },
  build: {
    outDir: resolve(__dirname, 'src/web/dist'),
    emptyOutDir: true,
    // Tauri packages (@tauri-apps/api, plugin-updater, plugin-process) are
    // bundled by Vite, not externalized. They call __TAURI_INTERNALS__
    // which only exists in the Tauri webview — but all imports are behind
    // `isTauri` guards or dynamic import() with try/catch, so they never
    // execute in browser mode.
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/web/src'),
    },
  },
});
