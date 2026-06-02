import { useEffect } from 'react';
import { getWsProtocols, getWsUrl } from '../lib/env';

/**
 * WebSocket live-sync to `/api/events`. The HTTP server watches the
 * SQLite WAL file and broadcasts `db.changed` when an MCP client (or
 * any other process) writes to the shared DB. On receive we refresh
 * every user-facing collection — cheap on loopback and keeps the UI
 * honest.
 *
 * Auth token is smuggled through `Sec-WebSocket-Protocol` because
 * browsers don't expose custom headers on WebSocket. The sidecar's
 * `verifyClient` hook rejects with 401 if the subprotocol doesn't
 * carry the right token.
 *
 * Reconnect uses exponential backoff (N16 2026-04-16): 1s → 2s → 4s
 * ... capped at 30s so a crashing sidecar doesn't get hammered.
 * Counter resets to 1s on every successful `onopen`.
 *
 * Message validation (N17 2026-04-16): only `{ type: 'db.changed' }`
 * is acted on; anything else is logged to `console.warn` at DEBUG
 * level (visible in DevTools) but never throws. Future message types
 * (heartbeat, auth-challenge, error) add a `case` here and become
 * type-checked by the discriminated union.
 *
 * R2 2026-04-17 — extracted from App.tsx.
 */
export interface LiveSyncRefreshers {
  refreshNotes: () => Promise<void>;
  refreshFolders: () => Promise<void>;
  refreshTags: () => Promise<void>;
  refreshTrash: () => Promise<void>;
  /** Optional per-tick signal for surfaces that don't have a simple
   *  "refetch their collection" entrypoint — e.g. the Direction Q
   *  ActivityPanel which needs to refetch its activity feed for the
   *  currently-open note. Called on every `db.changed` frame. */
  onTick?: () => void;
}

/** Every WebSocket frame the UI is prepared to handle. Adding a new
 * variant here gives you a compile error at the switch below until
 * you handle it — which is exactly the point. */
export type LiveSyncMessage =
  | { type: 'db.changed' };

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

function parseMessage(raw: unknown): LiveSyncMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { type?: unknown }).type !== 'string'
  ) {
    return null;
  }
  const { type } = parsed as { type: string };
  if (type === 'db.changed') return { type };
  return null;
}

/**
 * Pure WS-binding logic, factored out of `useLiveSync` so it can be
 * unit-tested without React/jsdom. The hook below is a thin
 * `useEffect` wrapper around this.
 *
 * Returns a `disconnect()` callback the caller invokes on unmount.
 *
 * Injection points (defaulted in the hook to the real DOM globals):
 *   - `wsCtor` — `(url, protocols?) => WebSocket`. Tests pass a fake.
 *   - `setTimeoutFn / clearTimeoutFn` — same shape as the globals.
 *   - `now` — unused at the moment but reserved for tests that want
 *     to assert on backoff scheduling.
 */
export interface ConnectLiveSyncOptions {
  url: string;
  protocols: string[];
  refresh: LiveSyncRefreshers;
  wsCtor?: (url: string, protocols?: string | string[]) => WebSocket;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export function connectLiveSync(opts: ConnectLiveSyncOptions): () => void {
  const {
    url,
    protocols,
    refresh,
    wsCtor = (u: string, p?: string | string[]) => (p ? new WebSocket(u, p) : new WebSocket(u)),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = opts;
  const { refreshNotes, refreshFolders, refreshTags, refreshTrash, onTick } = refresh;

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  let closed = false;
  /**
   * Refetch-on-open is for *recovery*, not for initial load. The App
   * has already fetched every collection by the time this hook is
   * mounted; re-fetching on the very first WS connect is wasted work.
   *
   * More importantly, it caused a feedback loop (2026-04-25 incident):
   * if any of the hook's deps ever changes ref between renders (e.g.
   * an inline `onTick={() => setLiveRev(n => n + 1)}`), the effect
   * re-runs → cleanup closes the old WS → new connectLiveSync runs →
   * onopen → refetchAll → setState → re-render → effect re-runs →
   * runaway 1000+ /api/notes hits per second on a busy session.
   *
   * Gating refetchAll on `hasOpenedOnce` makes the FIRST onopen of
   * each invocation a no-op. Real WS reconnects (server restart,
   * sleep/wake) still come through onclose → setTimeout → connect →
   * onopen, where `hasOpenedOnce` is true → refetchAll fires once.
   * Effect re-runs (which start a fresh invocation with the flag
   * reset to false) silently skip the refetch.
   */
  let hasOpenedOnce = false;

  const refetchAll = () => {
    refreshNotes().catch(console.error);
    refreshFolders().catch(console.error);
    refreshTags().catch(console.error);
    refreshTrash().catch(console.error);
    onTick?.();
  };

  function scheduleReconnect(): void {
    if (closed) return;
    reconnectTimer = setTimeoutFn(connect, backoffMs);
    // Double for next time, cap at 30s. A crashing sidecar eventually
    // probes once per 30 seconds rather than once per 3 seconds
    // forever; a recovered sidecar reconnects quickly because onopen
    // resets the counter.
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }

  function connect(): void {
    if (closed) return;
    try {
      ws = protocols.length > 0 ? wsCtor(url, protocols) : wsCtor(url);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      // Successful handshake — reset the exponential backoff so the
      // next genuine disconnect starts fresh at 1s.
      backoffMs = INITIAL_BACKOFF_MS;
      // Refetch only on RECONNECT, not on first open (see
      // `hasOpenedOnce` doc above). The first connect after mount
      // skips because the App has just fetched everything and a
      // duplicate fetch would be a no-op at best — and a feedback-
      // loop trigger at worst when the hook's deps churn between
      // renders. Reconnects (e.g. sidecar restart) still get the
      // catch-up refetch, since they go onclose → reconnect →
      // onopen with `hasOpenedOnce` already true.
      if (hasOpenedOnce) {
        refetchAll();
      }
      hasOpenedOnce = true;
    };

    ws.onmessage = (e) => {
      const msg = parseMessage(e.data);
      if (msg === null) {
        // Unknown frames are forward-compat territory — log once so
        // debugging new message types is possible without blowing
        // up the console, but never throw.
        if (typeof console !== 'undefined') {
          console.debug('[live-sync] ignoring unknown message', e.data);
        }
        return;
      }
      switch (msg.type) {
        case 'db.changed':
          refetchAll();
          return;
        // Exhaustive check — when LiveSyncMessage gets a new variant
        // TypeScript forces a new `case` here.
        default: {
          const _exhaustive: never = msg.type;
          void _exhaustive;
        }
      }
    };

    ws.onclose = () => {
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeoutFn(reconnectTimer);
    ws?.close();
  };
}

export function useLiveSync(
  envReady: boolean,
  refresh: LiveSyncRefreshers,
): void {
  const { refreshNotes, refreshFolders, refreshTags, refreshTrash, onTick } = refresh;

  useEffect(() => {
    if (!envReady) return;
    return connectLiveSync({
      url: getWsUrl(),
      protocols: getWsProtocols(),
      refresh: { refreshNotes, refreshFolders, refreshTags, refreshTrash, onTick },
    });
  }, [envReady, refreshNotes, refreshFolders, refreshTags, refreshTrash, onTick]);
}
