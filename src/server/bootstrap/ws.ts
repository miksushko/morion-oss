import { watch, existsSync, type FSWatcher } from 'node:fs';
import { dirname, basename } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';

/**
 * Constant-time equality over the subprotocol string. Browsers quote-embed
 * the token in plaintext in the Sec-WebSocket-Protocol header, so a fast
 * path `===` compare leaks token prefix bytes via short-circuit timing.
 * `timingSafeEqual` requires equal-length Buffers; callers must length-check
 * first and return false on mismatch.
 */
function constantTimeEq(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Double-check lengths after utf-8 encoding (in case of non-ASCII input)
  // so timingSafeEqual doesn't throw. Token is 64 hex chars, all ASCII, so
  // this branch is paranoia rather than hot-path.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Watches the SQLite WAL file for changes (cross-process writes from
 * `morion mcp`) and broadcasts a `db.changed` event to all connected
 * WebSocket clients so the UI can auto-refresh.
 *
 * Why WAL watcher instead of polling:
 * - Zero CPU when idle — OS-level `fs.watch` is event-driven
 * - Sub-second latency — UI sees MCP writes within the debounce window
 * - No extra HTTP requests, no timers, no busy loops
 */

const DEBOUNCE_MS = 500;

export function setupWalWatcher(
  httpServer: Server,
  dbPath: string,
): { wss: WebSocketServer; watcher: FSWatcher | null } {
  // Authenticate WebSocket connections via the Sec-WebSocket-Protocol
  // header. Browser WebSocket API doesn't allow custom request headers
  // so we smuggle the token through the subprotocol field: client opens
  // with protocols = ['morion-token-<HEX>'], server accepts only if the
  // protocol ends with the expected token. Dev mode (no MORION_API_TOKEN
  // env) skips this check.
  const expectedToken = process.env.MORION_API_TOKEN ?? '';
  const expectedProto = `morion-token-${expectedToken}`;
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/api/events',
    verifyClient:
      expectedToken.length > 0
        ? ({ req }, done) => {
            const raw = req.headers['sec-websocket-protocol'] ?? '';
            const protocols = (Array.isArray(raw) ? raw.join(',') : raw)
              .split(',')
              .map((p) => p.trim());
            // Constant-time compare every offered subprotocol against the
            // expected token-bearing one. Plain `===` early-exits on the
            // first mismatching byte; over the Tauri webview's local
            // socket this is unlikely to be exploitable, but we already
            // went to the trouble of constant-time compare on the HTTP
            // side (src/server/http.ts) so keeping both paths aligned is
            // cheaper than auditing the inconsistency later.
            const match = protocols.some((p) => constantTimeEq(p, expectedProto));
            done(match, match ? undefined : 401, match ? undefined : 'unauthorized');
          }
        : undefined,
    handleProtocols: expectedToken.length > 0
      ? (protocols: Set<string>) => {
          // Echo back the token protocol so the browser's WebSocket
          // handshake succeeds (RFC 6455 requires the server to select
          // one of the offered subprotocols or none).
          for (const p of protocols) {
            if (constantTimeEq(p, expectedProto)) return p;
          }
          return false;
        }
      : undefined,
  });
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  const broadcast = (msg: string) => {
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  };

  const walPath = dbPath + '-wal';
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const onWalChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      broadcast(JSON.stringify({ type: 'db.changed' }));
    }, DEBOUNCE_MS);
  };

  let watcher: FSWatcher | null = null;

  if (existsSync(walPath)) {
    // WAL file exists — watch it directly.
    try {
      watcher = watch(walPath, onWalChange);
      watcher.on('error', () => {});
    } catch {
      // Silently fall through to directory watch.
    }
  }

  if (!watcher) {
    // WAL doesn't exist yet or direct watch failed. Watch the parent
    // directory and filter for the WAL filename.
    const dir = dirname(dbPath);
    const walName = basename(walPath);
    try {
      watcher = watch(dir, (_, filename) => {
        if (filename === walName) onWalChange();
      });
      watcher.on('error', () => {});
    } catch {
      // If even directory watch fails, live sync is disabled.
      // The manual Refresh button still works.
    }
  }

  return { wss, watcher };
}
