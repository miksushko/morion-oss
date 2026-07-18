import { useEffect, useRef, useState, useCallback } from 'react';
import { Download, X } from 'lucide-react';
import { z } from 'zod';
import { getApiBaseSync, getApiToken, isTauri } from '../lib/env';

/** Build {Authorization-like} header for the custom token scheme. */
function authHeaders(): Record<string, string> {
  const t = getApiToken();
  return t ? { 'X-Morion-Token': t } : {};
}

declare const __APP_VERSION__: string;

// Strict x.y.z semver — no pre-release tags. A compromised release feed
// advertising an attacker-controlled "version" is refused at the schema
// gate before any network work. Pre-release shipping isn't supported; add
// a -alpha/-beta branch here when that changes.
//
// v1.2+ per-platform installers: the `platforms` map carries one entry
// per `<process.platform>-<process.arch>` key (e.g. `darwin-arm64`,
// `win32-x64`, `linux-x64`). The legacy `dmg_sha256` field is kept for
// older installed clients still on the v1.1.x schema — remove once all
// live installs are on v1.2+.
const platformEntrySchema = z.object({
  url: z.string().url().startsWith('https://github.com/miksushko/morion-releases/'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export const latestJsonSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  pub_date: z.string().optional(),
  platforms: z.record(platformEntrySchema).optional(),
  dmg_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const RELEASES_PAGE = 'https://github.com/miksushko/morion-releases/releases/latest';

/**
 * Ask the sidecar what platform + arch it's running on. Used to pick the
 * right entry from `latest.json.platforms`. Falls back to `darwin-arm64`
 * when the runtime probe fails — that was the only platform shipping
 * before the Windows port, so historical behaviour is preserved when the
 * sidecar or the probe is unavailable.
 */
async function fetchRuntimePlatformKey(): Promise<string> {
  try {
    const base = getApiBaseSync();
    const res = await fetch(`${base}/api/runtime`, { cache: 'no-store', headers: authHeaders() });
    if (!res.ok) return 'darwin-arm64';
    const data = (await res.json()) as { platform?: string; arch?: string };
    if (typeof data.platform !== 'string' || typeof data.arch !== 'string') {
      return 'darwin-arm64';
    }
    return `${data.platform}-${data.arch}`;
  } catch {
    return 'darwin-arm64';
  }
}

/**
 * Derive the installer URL + sha256 from the parsed `latest.json`:
 *
 *   1. If `platforms[<platform>-<arch>]` is present, use it. This is the
 *      v1.2+ path that covers macOS arm64, macOS x64, Windows x64, Linux.
 *   2. On darwin-arm64 only, fall back to the legacy DMG URL pattern so
 *      old releases still deliver updates during the cut-over.
 *   3. Otherwise return null — the banner shows a "Download" button that
 *      opens the releases page in the browser so the user can pick.
 */
export function resolveInstaller(
  parsed: z.infer<typeof latestJsonSchema>,
  platformKey: string,
): { url: string; sha256: string | null } | null {
  const entry = parsed.platforms?.[platformKey];
  if (entry) {
    return { url: entry.url, sha256: entry.sha256 ?? null };
  }
  // Legacy flat-schema fallback: fabricate the DMG URL ONLY when the
  // release predates the per-platform `platforms` map entirely (v1.1.x,
  // darwin-arm64 was the sole platform then). If `platforms` IS present
  // but merely lacks this platform — a PARTIAL publish where one build
  // leg failed — do NOT guess a URL: the asset may not exist and the
  // downloader hard-404s. Return null so the banner falls back to opening
  // the releases page, identical to every other platform. Real incident:
  // v1.5.2 shipped win32-only for ~1h after the macOS notarization leg
  // failed; macOS clients 404'd on the guessed Morion_1.5.2_aarch64.dmg.
  if (platformKey === 'darwin-arm64' && parsed.platforms === undefined) {
    return {
      url: `https://github.com/miksushko/morion-releases/releases/download/v${parsed.version}/Morion_${parsed.version}_aarch64.dmg`,
      sha256: parsed.dmg_sha256 ?? null,
    };
  }
  return null;
}

/**
 * Open an external https URL. In Tauri (`tauri://localhost`) plain
 * `<a target="_blank">` and `window.open` silently drop because the webview
 * has no default handler for external navigation. We invoke the Rust
 * `open_url` IPC command which shells out to `/usr/bin/open`. Outside
 * Tauri (browser / dev mode), fall back to `window.open`.
 */
async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_url', { url });
      return;
    } catch (err) {
      console.error('open_url IPC failed, falling back to window.open', err);
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Result of a manual update check (returned to HeaderMenu). */
export type UpdateCheckResult =
  | { status: 'available'; version: string }
  | { status: 'up-to-date' }
  | { status: 'unavailable' };

/**
 * Server-side download state — mirrors the union in
 * src/server/routes/updates.ts. `installerPath` is the v1.2+ generic
 * name; `dmgPath` is kept as an alias for legacy sidecars still on the
 * v1.1.x contract. Read `installerPath` with fallback.
 */
type DownloadStatus =
  | { state: 'idle' }
  | { state: 'downloading'; version: string; progress: number; bytesDone: number; bytesTotal: number }
  | { state: 'ready'; version: string; installerPath?: string; dmgPath?: string }
  | { state: 'error'; error: string };

interface UpdateInfo {
  version: string;
  downloadUrl: string;
  /** Optional — only set for releases built on the v0.97.0+ CI. */
  installerSha256?: string;
}

function isNewer(remote: string, local: string): boolean {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] ?? 0;
    const lv = l[i] ?? 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

async function checkForUpdate(): Promise<{
  result: UpdateCheckResult;
  downloadUrl: string | null;
  installerSha256: string | null;
}> {
  try {
    const base = getApiBaseSync();
    const [res, platformKey] = await Promise.all([
      fetch(`${base}/api/updates/latest`, {
        cache: 'no-store',
        headers: authHeaders(),
      }),
      fetchRuntimePlatformKey(),
    ]);
    if (!res.ok)
      return { result: { status: 'unavailable' }, downloadUrl: null, installerSha256: null };
    const data = await res.json();
    const parsed = latestJsonSchema.safeParse(data);
    if (!parsed.success) {
      return { result: { status: 'unavailable' }, downloadUrl: null, installerSha256: null };
    }
    const remoteVersion = parsed.data.version;
    if (!isNewer(remoteVersion, __APP_VERSION__)) {
      return { result: { status: 'up-to-date' }, downloadUrl: null, installerSha256: null };
    }
    const installer = resolveInstaller(parsed.data, platformKey);
    // No platform entry (e.g. Windows user before the first win32 release
    // ships): still surface `available` so the user sees a banner and can
    // click through to the releases page. `downloadUrl=null` flips the
    // Download button into a "Open releases page" fallback.
    return {
      result: { status: 'available', version: remoteVersion },
      downloadUrl: installer?.url ?? null,
      installerSha256: installer?.sha256 ?? null,
    };
  } catch {
    return { result: { status: 'unavailable' }, downloadUrl: null, installerSha256: null };
  }
}

async function fetchDownloadStatus(): Promise<DownloadStatus> {
  const base = getApiBaseSync();
  const res = await fetch(`${base}/api/updates/status`, {
    cache: 'no-store',
    headers: authHeaders(),
  });
  if (!res.ok) return { state: 'idle' };
  return (await res.json()) as DownloadStatus;
}

async function startDownload(
  url: string,
  version: string,
  installerSha256: string | null,
): Promise<void> {
  const base = getApiBaseSync();
  await fetch(`${base}/api/updates/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      url,
      version,
      // Server accepts both `sha256` (preferred) and `dmg_sha256` (legacy
      // alias). Emit both so a server still running the old schema before
      // the Windows port rollout keeps working.
      ...(installerSha256 ? { sha256: installerSha256, dmg_sha256: installerSha256 } : {}),
    }),
  });
}

async function installAndRestart(installerPath: string): Promise<void> {
  if (!isTauri) {
    // Browser / dev mode — there's nothing to install. Just log.
    console.warn('installAndRestart called outside Tauri; ignoring');
    return;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  // Pass both arg names during the rollout window: Rust shells that
  // still expect `dmgPath` (legacy macOS build) use that; updated
  // Windows/Linux/macOS builds read `installerPath`. Rust-side serde
  // drops unknown fields so this is safe in every direction.
  await invoke('install_update_and_restart', { installerPath, dmgPath: installerPath });
}

/**
 * Three-phase auto-update banner.
 *
 *   available  → "Download" button. Click triggers sidecar download +
 *                begins polling /api/updates/status.
 *   downloading → progress bar with N% / "Downloading vX.Y.Z…".
 *                Polls every 500ms until status flips.
 *   ready      → "Restart to install" button. Click invokes the Rust
 *                IPC `install_update_and_restart` which writes a bash
 *                helper, spawns it detached, and exits the app. Helper
 *                waits for our PID to die, mounts the DMG, swaps the
 *                .app, relaunches.
 *   error      → red banner with the message; "Try again" resets to
 *                available.
 *
 * Outside Tauri the Restart button still appears but is a no-op + warns
 * in console — the auto-install path only makes sense in the desktop app.
 */
export function UpdateBanner({
  onRegisterCheck,
  ready = true,
}: {
  onRegisterCheck?: (fn: () => Promise<UpdateCheckResult>) => void;
  ready?: boolean;
}) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [download, setDownload] = useState<DownloadStatus>({ state: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  const pollTimer = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollTimer.current = window.setInterval(async () => {
      const status = await fetchDownloadStatus();
      setDownload(status);
      if (status.state === 'ready' || status.state === 'error' || status.state === 'idle') {
        stopPolling();
      }
    }, 500);
  }, [stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const doCheck = useCallback(async (): Promise<UpdateCheckResult> => {
    const { result, downloadUrl, installerSha256 } = await checkForUpdate();
    if (result.status === 'available') {
      setUpdate({
        version: result.version,
        downloadUrl: downloadUrl ?? '',
        installerSha256: installerSha256 ?? undefined,
      });
      setDismissed(false);
      // If the sidecar already finished a previous download for this same
      // version, surface "Restart to install" immediately instead of asking
      // the user to download again.
      const status = await fetchDownloadStatus();
      if ((status.state === 'ready' || status.state === 'downloading') && status.version === result.version) {
        setDownload(status);
        if (status.state === 'downloading') startPolling();
      }
    }
    return result;
  }, [startPolling]);

  useEffect(() => {
    onRegisterCheck?.(doCheck);
  }, [onRegisterCheck, doCheck]);

  useEffect(() => {
    if (ready) void doCheck();
  }, [ready, doCheck]);

  const onDownloadClick = useCallback(async () => {
    if (!update || !update.downloadUrl) {
      // No installer URL for this platform — fall back to opening the
      // releases page in browser so the user can grab the right file.
      void openExternal(RELEASES_PAGE);
      return;
    }
    setDownload({ state: 'downloading', version: update.version, progress: 0, bytesDone: 0, bytesTotal: 0 });
    startPolling();
    try {
      await startDownload(update.downloadUrl, update.version, update.installerSha256 ?? null);
    } catch (err) {
      stopPolling();
      setDownload({ state: 'error', error: (err as Error).message });
    }
  }, [update, startPolling, stopPolling]);

  const onInstallClick = useCallback(async () => {
    if (download.state !== 'ready') return;
    // `installerPath` (v1.2+) is preferred; `dmgPath` (legacy) is the
    // macOS-only name still emitted by pre-Windows-port sidecars.
    const path = download.installerPath ?? download.dmgPath;
    if (!path) {
      setDownload({ state: 'error', error: 'installer path missing in ready state' });
      return;
    }
    try {
      await installAndRestart(path);
      // installAndRestart triggers app exit on success, so this point
      // shouldn't normally be reached. If it is, the user is in browser
      // mode — show a hint via the error state.
      if (!isTauri) {
        setDownload({ state: 'error', error: 'auto-install only works in the desktop app' });
      }
    } catch (err) {
      setDownload({ state: 'error', error: (err as Error).message });
    }
  }, [download]);

  const onRetry = useCallback(() => {
    setDownload({ state: 'idle' });
  }, []);

  if (!update || dismissed) return null;

  return (
    <div className="flex items-center gap-3 border-b border-border bg-primary/10 px-4 py-2 text-sm">
      <Download className="h-4 w-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 text-foreground">
        {download.state === 'downloading' ? (
          <>
            Downloading <span className="font-medium">v{update.version}</span>… {download.progress}%
            {download.bytesTotal > 0 && (
              <span className="ml-2 text-muted-foreground">
                ({(download.bytesDone / 1_048_576).toFixed(1)} / {(download.bytesTotal / 1_048_576).toFixed(1)} MB)
              </span>
            )}
          </>
        ) : download.state === 'ready' ? (
          <>
            Update <span className="font-medium">v{update.version}</span> ready to install
          </>
        ) : download.state === 'error' ? (
          <>
            Update failed: <span className="text-destructive">{download.error}</span>
          </>
        ) : (
          <>
            Update available: <span className="font-medium">v{update.version}</span>
          </>
        )}
      </span>

      {download.state === 'idle' && (
        <button
          type="button"
          onClick={() => void onDownloadClick()}
          className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Download
        </button>
      )}

      {download.state === 'downloading' && (
        <span className="shrink-0 rounded-md bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
          {download.progress}%
        </span>
      )}

      {download.state === 'ready' && (
        <button
          type="button"
          onClick={() => void onInstallClick()}
          className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Restart to install
        </button>
      )}

      {download.state === 'error' && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Try again
        </button>
      )}

      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss update banner"
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
