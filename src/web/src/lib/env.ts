/**
 * Runtime environment detection for Tauri vs browser.
 *
 * When the app runs inside Tauri (tauri://localhost), IPC is available
 * and API calls go to the sidecar on http://127.0.0.1:PORT. In browser
 * mode (localhost:5173 or localhost:7777), relative paths work via
 * same-origin or Vite proxy — no special handling needed.
 */

/** True when running inside a Tauri webview (tauri://localhost). */
export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let _sidecarPort: number | null = null;
let _apiBase: string | null = null;
let _apiToken: string = '';

/**
 * Resolves the sidecar HTTP port + API token via Tauri IPC and caches
 * the result. Must be called once at app init before any API calls.
 * In browser/dev mode returns "" for base and "" for token (skips auth).
 */
export async function getApiBase(): Promise<string> {
  if (!isTauri) return '';
  if (_apiBase !== null) return _apiBase;

  const { invoke } = await import('@tauri-apps/api/core');
  _sidecarPort = await invoke<number>('get_sidecar_port');
  _apiBase = `http://127.0.0.1:${_sidecarPort}`;
  try {
    _apiToken = await invoke<string>('get_api_token');
  } catch {
    // Older Tauri shell without get_api_token — dev / legacy builds.
    // Fall through with empty token; the sidecar's dev-mode auth
    // middleware treats empty MORION_API_TOKEN the same way.
    _apiToken = '';
  }
  return _apiBase;
}

/**
 * Synchronous — returns cached base URL or "" if not yet resolved.
 * Safe to call before getApiBase() completes (returns "" so relative
 * paths work as fallback).
 */
export function getApiBaseSync(): string {
  return _apiBase ?? '';
}

/**
 * API token resolved from the Tauri shell (prod) or empty string (dev /
 * browser). All fetches via the shared api wrapper inject this as the
 * X-Morion-Token header; the sidecar's auth middleware rejects any
 * mismatch with 401.
 */
export function getApiToken(): string {
  return _apiToken;
}

/**
 * WebSocket URL for /api/events (live sync).
 * In Tauri: ws://127.0.0.1:PORT/api/events
 * In browser: derives from window.location
 */
export function getWsUrl(): string {
  if (isTauri && _sidecarPort !== null) {
    return `ws://127.0.0.1:${_sidecarPort}/api/events`;
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/events`;
}

/**
 * Sec-WebSocket-Protocol value that carries the auth token. Browser
 * WebSocket API doesn't allow custom headers, so we smuggle the token
 * as a subprotocol string: `morion-token-<HEX>`. The sidecar's
 * verifyClient + handleProtocols in setupWalWatcher accept only the
 * exact match. Dev/browser mode returns an empty array → no protocol
 * offered, sidecar accepts when MORION_API_TOKEN is unset.
 */
export function getWsProtocols(): string[] {
  return _apiToken ? [`morion-token-${_apiToken}`] : [];
}
