import { isTauri } from './env';

/**
 * Open a user-content `https://` link in the system default browser.
 *
 * In Tauri (webview at `tauri://localhost`), a plain anchor click or
 * `window.open` either gets swallowed or navigates the webview itself —
 * both destroy the app. We route through the `open_external_url` Rust
 * IPC which shells out to `/usr/bin/open`. Unlike the allow-list'ed
 * `open_url` IPC (used for hardcoded system buttons), this accepts any
 * `http(s)://` URL and rejects `javascript:` / `file:` / `data:` —
 * suitable for anchor hrefs embedded in note bodies AND for legal-link
 * CTAs like the first-run consent screen.
 *
 * In a plain browser (dev preview at localhost:5173) we fall back to
 * `window.open` so the same component works end-to-end in dev without
 * a Tauri shell.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_external_url', { url });
      return;
    } catch (err) {
      console.error('open_external_url IPC failed', err);
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
