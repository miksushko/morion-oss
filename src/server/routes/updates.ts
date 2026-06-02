import type { Hono } from 'hono';
import { mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { verifyReleaseSignature } from '../../core/crypto/verifyReleaseSignature.js';

/**
 * Auto-updater (Slack-style).
 *
 * Three-phase flow:
 *   1. `GET /api/updates/latest` — proxy GitHub Releases
 *      `latest.json`. Browser can't fetch GitHub directly from
 *      `http://127.0.0.1` (CORS on external origins).
 *   2. `POST /api/updates/download` — stream the installer
 *      (`.dmg` on macOS, `.msi` / `.exe` on Windows, `.AppImage` /
 *      `.deb` later for Linux) to the platform-appropriate cache dir
 *      with sha256 verify and a 500 MB hard cap (abort + unlink on
 *      exceed). Runs in the background; response returns immediately
 *      so the UI can poll.
 *   3. `GET /api/updates/status` — union state
 *      (`idle | downloading | ready | error`) used by the three-phase
 *      UI in `UpdateBanner.tsx`.
 *
 * The actual installer (Rust IPC `install_update_and_restart`) lives
 * in `src-tauri/src/main.rs` — we never touch `/Applications/` /
 * `%PROGRAMFILES%` from Node; that's the shell's job after
 * `app.exit(0)`.
 */

type UpdateState =
  | { state: 'idle' }
  | { state: 'downloading'; version: string; progress: number; bytesDone: number; bytesTotal: number }
  // `dmgPath` kept as an alias for `installerPath` during the Windows
  // port rollout — legacy UpdateBanner + Rust IPC still read `dmgPath`.
  // Remove the alias once both are on `installerPath`.
  | { state: 'ready'; version: string; installerPath: string; dmgPath: string }
  | { state: 'error'; error: string };

const ALLOWED_INSTALLER_PREFIX = 'https://github.com/miksushko/morion-releases/';

// Which installer extensions we accept per platform. The cleanup pass on
// `POST /api/updates/download` uses this set to purge stale entries before
// starting a fresh download.
const INSTALLER_EXTENSIONS = ['.dmg', '.msi', '.exe', '.AppImage', '.deb'];

/**
 * Per-platform cache dir for downloaded installers. Matches Tauri 2's
 * `app_cache_dir()` convention on each OS so the Rust updater helper
 * finds the same file without env plumbing:
 *
 *   macOS:   ~/Library/Caches/<bundle>/updates
 *   Windows: %LOCALAPPDATA%\<bundle>\updates     (= ~\AppData\Local\<id>\updates)
 *   Linux:   $XDG_CACHE_HOME/<bundle>/updates    (fallback ~/.cache/<bundle>/updates)
 *
 * Never use `process.env.HOME` directly: launchd / systemd-spawned
 * processes can run with a stripped env, which would silently resolve to
 * `/Library/Caches/...` owned by root on macOS (and the equivalent on
 * other platforms). `os.homedir()` reads from the OS user database
 * instead — always correct for the current user.
 */
function cacheDirForUpdates(): string {
  const home = homedir();
  if (!home) throw new Error('home directory unavailable');
  const bundleId = process.env.MORION_BUNDLE_ID ?? 'com.morion.Morion';
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Caches', bundleId, 'updates');
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const base =
      localAppData && localAppData.length > 0
        ? localAppData
        : join(home, 'AppData', 'Local');
    return join(base, bundleId, 'updates');
  }
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(home, '.cache');
  return join(base, bundleId, 'updates');
}

/**
 * Derive a safe, cache-local filename from the upstream URL. The release
 * workflow publishes assets like `Morion_1.1.4_aarch64.dmg` or
 * `Morion_1.1.4_x64-setup.exe`, so we trust the filename portion of the
 * URL after stripping any path traversal. Anything outside the allow-list
 * extension set falls back to a version-stamped default.
 */
function installerFilenameForUrl(url: string, version: string): string {
  try {
    const parsed = new URL(url);
    const base = basename(parsed.pathname);
    // Reject anything that's not a pure filename: no slashes, no `..`,
    // non-empty, reasonable length. This is defence-in-depth on top of
    // the allow-listed URL prefix.
    if (
      base.length > 0 &&
      base.length < 200 &&
      !base.includes('/') &&
      !base.includes('\\') &&
      !base.includes('..') &&
      INSTALLER_EXTENSIONS.some((ext) => base.toLowerCase().endsWith(ext))
    ) {
      return base;
    }
  } catch {
    // Fall through to default name.
  }
  const fallbackExt =
    process.platform === 'win32' ? '.msi' : process.platform === 'darwin' ? '.dmg' : '.AppImage';
  return `Morion_${version}${fallbackExt}`;
}

const downloadSchema = z.object({
  url: z.string().url().startsWith(ALLOWED_INSTALLER_PREFIX),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  // Hex-encoded sha256 from latest.json. Optional during rollout: older
  // releases don't have it. When present, we verify at end of download.
  // Accept both `sha256` (preferred, platform-agnostic) and legacy
  // `dmg_sha256` (v0.9x macOS releases) so the UI can migrate without a
  // lockstep server upgrade.
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  dmg_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export function registerUpdateRoutes(app: Hono): void {
  // Module-scope state per app build. sidecar restart resets it
  // (fine — partial DMG is wiped before each fresh download).
  let updateState: UpdateState = { state: 'idle' };
  // Cached copy of the dmg_sha256 for the version we're currently
  // downloading — set on POST /download and verified at end of stream.
  // If the client doesn't send it (older UI / legacy release) we skip
  // verification with a warning.
  let expectedSha256: string | null = null;

  app.get('/api/updates/latest', async (c) => {
    // C2 2026-04-17 — ed25519 signature on latest.json. Fetches the
    // JSON and the .sig side-by-side from morion-releases, verifies
    // the signature against the embedded public key, returns the
    // JSON on match. Without this, a compromised GitHub PAT could
    // publish a malicious latest.json pointing at a DMG the attacker
    // also controls (with valid dmg_sha256 for their DMG) — the
    // in-stream sha256 check (N/a before C2) would not help. The
    // private key lives only in GitHub Actions secrets, so a PAT
    // leak alone can't produce a valid signature.
    //
    // latest.json.sig is a 64-byte raw Ed25519 signature produced by
    // `openssl pkeyutl -sign -rawin -inkey MORION_RELEASE_PRIVATE_KEY
    //  -in latest.json -out latest.json.sig` in publish.yml.
    //
    // Backward compat: older releases on morion-releases have no
    // .sig file yet. During the rollout window we log a warning
    // when the .sig fetch 404s and accept the unsigned json — that
    // way users on v0.99.x can still receive their own update
    // notifications. After the first signed release ships to
    // everyone, tighten this to refuse unsigned.
    try {
      const [jsonRes, sigRes] = await Promise.all([
        fetch(
          'https://github.com/miksushko/morion-releases/releases/latest/download/latest.json',
          { headers: { 'User-Agent': 'morion-update-check' } },
        ),
        fetch(
          'https://github.com/miksushko/morion-releases/releases/latest/download/latest.json.sig',
          { headers: { 'User-Agent': 'morion-update-check' } },
        ),
      ]);
      if (!jsonRes.ok) return c.json({ error: 'upstream error' }, 502);
      const jsonBytes = new Uint8Array(await jsonRes.clone().arrayBuffer());
      const data = await jsonRes.json();

      if (!sigRes.ok) {
        // Rollout window — no signature on this release yet. Log
        // loudly and fall through. Remove once every live release
        // carries a .sig (tracked in tasks/security_improvements.md
        // C2 follow-up).
        console.warn(
          `[updates] latest.json.sig missing (HTTP ${sigRes.status}) — ` +
            'accepting unsigned. Upgrade the release to add a signature.',
        );
        return c.json(data);
      }
      const signature = new Uint8Array(await sigRes.arrayBuffer());
      if (!verifyReleaseSignature(jsonBytes, signature)) {
        // Signature mismatch. Either the JSON was tampered, the
        // signature was tampered, or the keypair rotated and this
        // app is still carrying the old public key. All are refuse-
        // to-update situations — surfacing the banner without
        // verification would defeat the whole point.
        console.error('[updates] latest.json signature verification FAILED');
        return c.json({ error: 'signature_invalid' }, 502);
      }
      return c.json(data);
    } catch {
      return c.json({ error: 'fetch failed' }, 502);
    }
  });

  app.post('/api/updates/download', async (c) => {
    if (updateState.state === 'downloading') {
      return c.json({ ok: true, alreadyRunning: true, state: updateState });
    }
    if (updateState.state === 'ready') {
      return c.json({ ok: true, alreadyReady: true, state: updateState });
    }
    const body = downloadSchema.parse(await c.req.json());
    expectedSha256 = body.sha256 ?? body.dmg_sha256 ?? null;
    const dir = cacheDirForUpdates();
    mkdirSync(dir, { recursive: true });
    // Clean up old installers + any stale `.partial` from previous
    // interrupted runs before starting the new download. We keep the
    // cache dir to a single active installer at a time, ~180 MB each.
    try {
      const { readdirSync, unlinkSync } = await import('node:fs');
      for (const entry of readdirSync(dir)) {
        const isInstaller = INSTALLER_EXTENSIONS.some((ext) =>
          entry.toLowerCase().endsWith(ext),
        );
        if (isInstaller || entry.endsWith('.partial')) {
          try {
            unlinkSync(join(dir, entry));
          } catch {
            // best-effort — if it's locked we'll just overwrite below
          }
        }
      }
    } catch {
      // cache dir just got created — nothing to clean
    }
    const dest = join(dir, installerFilenameForUrl(body.url, body.version));
    const tmpDest = `${dest}.partial`;
    updateState = { state: 'downloading', version: body.version, progress: 0, bytesDone: 0, bytesTotal: 0 };
    // Fire-and-forget — the response returns immediately, the actual
    // download advances updateState in the background.
    //
    // Stream to disk instead of buffering in memory: a compromised
    // upstream could send 10 GB and OOM the sidecar (with SQLite's WAL
    // held open in the same process). The 500 MB cap aborts early if
    // the payload exceeds what a real Morion DMG ever is (~180 MB at
    // v0.96.x, with headroom).
    const MAX_DMG_BYTES = 500 * 1024 * 1024;
    void (async () => {
      const controller = new AbortController();
      let handle: Awaited<ReturnType<typeof import('node:fs/promises').open>> | null = null;
      const { createHash } = await import('node:crypto');
      const hasher = createHash('sha256');
      try {
        const res = await fetch(body.url, {
          headers: { 'User-Agent': 'morion-updater' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          updateState = { state: 'error', error: `download failed: HTTP ${res.status}` };
          return;
        }
        const total = Number.parseInt(res.headers.get('content-length') ?? '0', 10) || 0;
        if (total > MAX_DMG_BYTES) {
          updateState = { state: 'error', error: `upstream DMG too large (${total} > ${MAX_DMG_BYTES})` };
          return;
        }
        updateState = { state: 'downloading', version: body.version, progress: 0, bytesDone: 0, bytesTotal: total };
        const { open } = await import('node:fs/promises');
        handle = await open(tmpDest, 'w');
        let bytesDone = 0;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          bytesDone += value.byteLength;
          if (bytesDone > MAX_DMG_BYTES) {
            controller.abort();
            throw new Error(`DMG exceeded ${MAX_DMG_BYTES} byte cap mid-stream`);
          }
          hasher.update(value);
          await handle.write(value);
          updateState = {
            state: 'downloading',
            version: body.version,
            bytesDone,
            bytesTotal: total,
            progress: total > 0 ? Math.round((bytesDone / total) * 100) : 0,
          };
        }
        await handle.close();
        handle = null;
        // Verify sha256 BEFORE the atomic rename. If it doesn't
        // match, we never expose a tampered installer to the IPC —
        // the .partial file gets unlinked in the catch below.
        const computed = hasher.digest('hex');
        if (expectedSha256 && computed !== expectedSha256) {
          throw new Error(
            `sha256 mismatch: expected ${expectedSha256}, got ${computed}`,
          );
        }
        if (!expectedSha256) {
          console.warn('[updates] no sha256 in request; skipping verification');
        }
        // Atomic rename so a partial file is never named like a
        // complete one. Windows pitfall: Defender / third-party AV
        // grabs an exclusive scan lock on the freshly-closed
        // `.partial` immediately after the fd close, and the rename
        // EPERMs while the scan is in flight. macOS doesn't have
        // this class of issue. Retry with backoff for ~10 s before
        // surfacing the error to the UI.
        //
        // We also pre-clobber any stale `.exe` at the destination
        // path. Node's `renameSync` overwrites on Windows when both
        // operands are on the same volume, but only if the
        // destination isn't held open by an AV scan or by Explorer
        // pre-fetch. Unlinking first turns "rename atop locked file"
        // into "rename into clean slot", which AV tolerates better.
        const RENAME_ATTEMPTS = [0, 250, 500, 1000, 2000, 4000];
        const { unlinkSync, existsSync } = await import('node:fs');
        let renameErr: Error | null = null;
        for (const delay of RENAME_ATTEMPTS) {
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          try {
            if (existsSync(dest)) {
              try {
                unlinkSync(dest);
              } catch {
                // dest is locked by AV/Explorer — fall through to
                // rename which may still succeed if the lock is
                // delete-share, or fail and we retry.
              }
            }
            renameSync(tmpDest, dest);
            renameErr = null;
            break;
          } catch (e) {
            renameErr = e as Error;
            // Continue to next backoff slot.
          }
        }
        if (renameErr) throw renameErr;
        updateState = {
          state: 'ready',
          version: body.version,
          installerPath: dest,
          dmgPath: dest,
        };
      } catch (err) {
        if (handle) {
          try { await handle.close(); } catch { /* ignore */ }
        }
        // Leave no partially-written file behind.
        try {
          const { unlinkSync } = await import('node:fs');
          unlinkSync(tmpDest);
        } catch {
          // file may not exist yet — fine
        }
        updateState = { state: 'error', error: (err as Error).message };
      }
    })();
    return c.json({ ok: true, started: true });
  });

  app.get('/api/updates/status', (c) => c.json(updateState));
}
