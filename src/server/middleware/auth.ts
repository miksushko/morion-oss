import type { Hono } from 'hono';

/**
 * X-Morion-Token gate (Direction I, v0.97.0).
 *
 * Every `/api/*` request (except `/api/health`, which the Rust shell
 * hits before the webview is ready) must carry an `X-Morion-Token`
 * header that matches `MORION_API_TOKEN` from the sidecar's env. The
 * Tauri shell generates the token at launch, propagates it via env
 * + IPC, so only the webview (or somebody who can read Tauri IPC)
 * can talk to us — closes the "any local process on 127.0.0.1" +
 * DNS-rebinding attack window.
 *
 * Dev mode (`MORION_API_TOKEN` unset or empty) skips the gate so
 * `npm run dev` and vitest tests keep working unchanged.
 *
 * The compare is manual XOR so token length / prefix can't be
 * recovered via timing. Token is fixed 64 hex chars — the length
 * check is redundant but keeps the early-return cheap.
 */
export function registerAuthGate(app: Hono): void {
  const expectedToken = process.env.MORION_API_TOKEN ?? '';
  if (expectedToken.length === 0) return;

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health') return next();
    // SSE endpoints can't set custom headers from the browser
    // EventSource API, so they accept the token via `?token=` query
    // param as a fallback. The constant-time compare below applies
    // identically. Loopback-only binding still rules out remote
    // exfiltration; the query-param leak risk is browser history /
    // referer, both of which stay local. The path predicate is
    // narrow on purpose — only stream endpoints get this treatment.
    const headerToken = c.req.header('X-Morion-Token') ?? '';
    const queryToken =
      headerToken.length === 0 && c.req.path.endsWith('/stream')
        ? new URL(c.req.url).searchParams.get('token') ?? ''
        : '';
    const token = headerToken.length > 0 ? headerToken : queryToken;
    if (token.length !== expectedToken.length) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    let diff = 0;
    for (let i = 0; i < token.length; i++) {
      diff |= token.charCodeAt(i) ^ expectedToken.charCodeAt(i);
    }
    if (diff !== 0) return c.json({ error: 'unauthorized' }, 401);
    return next();
  });
}
