import { useEffect, useState } from 'react';
import { getApiBase, isTauri } from '../lib/env';

/**
 * Resolve Tauri IPC once before any API call fires. In Tauri the
 * sidecar port is discovered via `invoke('get_sidecar_port')`, and the
 * API token via `invoke('get_api_token')`; both are cached inside
 * `src/web/src/lib/env.ts`. Before resolution, `getApiBaseSync()`
 * returns an empty string and any fetch would hit the Vite dev server
 * (404 in prod webview).
 *
 * In browser / dev there's no Tauri, so we flip to ready immediately.
 *
 * Returns `true` once it's safe to fire `api.*` calls; `false` while
 * waiting. The main App effect keys every data-load on this boolean.
 *
 * R2 2026-04-17 — extracted from App.tsx.
 */
export function useEnvReady(): boolean {
  const [envReady, setEnvReady] = useState(!isTauri);

  useEffect(() => {
    if (!isTauri) return;
    getApiBase()
      .then(() => setEnvReady(true))
      .catch(() => setEnvReady(true)); // degrade gracefully
  }, []);

  return envReady;
}
