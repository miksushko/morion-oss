import type { Hono } from 'hono';

/**
 * CORS for the Morion sidecar. Tauri webview on `tauri://localhost` makes
 * cross-origin requests to the loopback HTTP server on
 * `http://127.0.0.1:PORT`, which the browser treats as cross-origin even
 * though both live on the same machine. The allow-list intentionally
 * covers only the three origins Morion ships against:
 *
 *   - `tauri://localhost` — the production webview on macOS/Linux
 *   - `http://tauri.localhost` — the production webview on Windows/WebView2
 *   - `http://localhost:*` — `npm run dev:web` (Vite)
 *   - `http://127.0.0.1:*` — legacy/alt dev URLs + the sidecar's own
 *     `/api/health` probe from Rust
 *
 * `X-Total-Count` is exposed so paginated `GET /api/notes` responses can
 * read the total server-side. No other custom headers cross the origin
 * boundary.
 *
 * Auth is NOT handled here — the X-Morion-Token gate lives in
 * `./auth.ts` and runs after CORS so preflight OPTIONS responses still
 * succeed without a token.
 */
export function registerCors(app: Hono): void {
  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin') ?? '';
    // WebView2 on Windows ≥128 ships Chromium that sends `Origin: null`
    // for fetches from custom schemes (including `tauri://localhost`).
    // macOS WKWebView sends the actual `tauri://localhost` origin, which
    // is why the same bundle worked on macOS through v1.2.3 but blew up
    // with "Failed to fetch" on every authed request in the Windows
    // webview. We accept `null` as a first-class allowed origin and
    // echo it back verbatim — per CORS spec `Access-Control-Allow-Origin:
    // null` is a valid response that unblocks the real request. The
    // security story still holds because the sidecar is loopback-only
    // AND gated by the per-session `X-Morion-Token` header; `null`
    // origin alone can't reach user data.
    if (
      origin === 'tauri://localhost' ||
      origin === 'http://tauri.localhost' ||
      origin === 'https://tauri.localhost' ||
      origin === 'null' ||
      origin.startsWith('http://localhost:') ||
      origin.startsWith('http://127.0.0.1:')
    ) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type, X-Morion-Token');
      c.header('Access-Control-Expose-Headers', 'X-Total-Count');
      // Private Network Access preflight (Chromium 117+, enforced by
      // WebView2 on Windows ≥130). When a page served from a "public"
      // context (tauri://localhost) fetches a resource on a loopback
      // IP (127.0.0.1), the browser sends a preflight carrying
      // `Access-Control-Request-Private-Network: true` and blocks the
      // real request unless the server echoes
      // `Access-Control-Allow-Private-Network: true`. macOS WKWebView
      // historically didn't enforce PNA, which is why the same bundle
      // worked on macOS through v1.2.2 but died with "Failed to fetch"
      // from the Windows consent screen (after the sidecar was
      // verified reachable via PowerShell curl). Header must go on
      // BOTH the preflight response AND the real response per the
      // WICG spec — easier to just always set it.
      c.header('Access-Control-Allow-Private-Network', 'true');
    }
    if (c.req.method === 'OPTIONS') {
      c.status(204);
      return c.body(null);
    }
    return next();
  });
}
