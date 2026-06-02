/** Map Node's `process.platform` to a human-readable label so the
 *  About section reads "macOS · arm64" instead of "darwin · arm64". */
export function formatPlatform(platform: string): string {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return platform;
  }
}

/**
 * Format a USD amount for the Usage / Limits dashboards.
 *
 * - `0` renders as `$0.00`
 * - `< 0.01` renders with 4-decimal precision so a $0.0042 row doesn't
 *   collapse to `$0.00`
 * - everything else uses 2-decimal precision
 */
export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Open a URL out of the app. In Tauri shells we route through the
 * `opener` plugin so the platform's default browser handles it; in the
 * dev / web build we fall back to `window.open`. Mirrors the legacy
 * `SubscriptionPanel.tsx` behaviour so the same link works under both
 * the Vite dev server and the Tauri WebView.
 */
export async function openExternal(url: string) {
  const isTauri =
    typeof window !== 'undefined' &&
    typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
      'undefined';
  if (isTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('plugin:opener|open_url', { url });
      return;
    } catch {
      // Fall through to window.open
    }
  }
  window.open(url, '_blank', 'noopener');
}
