/**
 * Last-gasp note save for tab-close / refresh / navigation events.
 *
 * The normal save path is the 500ms debounced PATCH inside `App.tsx`. That
 * loses data if the user closes the tab inside the debounce window — the
 * timer never fires, the React unmount cleanup isn't guaranteed when the
 * tab is being torn down, and any inflight `fetch` would be killed with
 * the page.
 *
 * `fetch(..., { keepalive: true })` is exactly the escape hatch the
 * platform offers for this. The browser keeps the request alive after the
 * document is gone, so the bytes still land on the server. We use it from
 * a `pagehide` listener (the modern, bfcache-friendly replacement for
 * `beforeunload`) and from `visibilitychange→hidden`, which fires reliably
 * on iOS Safari when the user backgrounds the tab.
 *
 * Failure handling is intentionally minimal: by definition we're running
 * in a window that's about to disappear, so we can't show toasts, retry,
 * or block navigation. We swallow the error after logging it.
 */
import { getApiBaseSync, getApiToken } from './env';

export type NotePatch = Partial<{
  body: string;
  folderId: string | null;
  tags: string[];
  pinned: boolean;
}>;

export function flushPendingPatchKeepalive(id: string, patch: NotePatch): void {
  // Cap the body so we never blow the 64KB keepalive budget. A note with
  // a body that large is wildly out of MVP scope; if it ever happens we
  // prefer dropping the keepalive flush over a silent failure mode where
  // the browser refuses the entire request.
  try {
    // Mirror the auth header from the main api wrapper. Without this,
    // every pagehide/visibilitychange flush in a prod Tauri build (where
    // MORION_API_TOKEN is set) gets a silent 401 from the sidecar and the
    // user's last edit before closing the tab evaporates. Dev mode returns
    // "" from getApiToken() and the sidecar's middleware skips auth when
    // MORION_API_TOKEN is unset, so tests and `npm run dev` keep working.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const token = getApiToken();
    if (token) headers['X-Morion-Token'] = token;

    void fetch(`${getApiBaseSync()}/api/notes/${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patch),
      keepalive: true,
    });
  } catch (err) {
    // The only synchronous throw here is the keepalive size cap. Log it
    // so it shows up in the user's devtools the next time they open the
    // app, but never let it bubble — we are in a teardown listener.
    console.error('keepalive flush failed', err);
  }
}
