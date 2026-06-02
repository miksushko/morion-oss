import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  dbPath: z.string(),
  httpPort: z.number().int().min(1).max(65535).default(7777),
  httpHost: z.string().default('127.0.0.1'),
  embeddings: z
    .object({
      // `transformers` runs @huggingface/transformers (ONNX Runtime) in-process.
      // `noop` disables semantic search entirely; the system runs FTS5-only.
      provider: z.enum(['transformers', 'noop']).default('transformers'),
      // Hugging Face model id. Default is Xenova/multilingual-e5-small (384-dim,
      // ~120 MB, multilingual). Must match the EMBEDDING_DIM in db/client.ts.
      model: z.string().default('Xenova/multilingual-e5-small'),
    })
    .default({
      provider: 'transformers',
      model: 'Xenova/multilingual-e5-small',
    }),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Map a bundle identifier to the platform-appropriate per-user config dir.
 * Mirrors Tauri 2's `app_config_dir()` on each OS so the sidecar and the
 * Tauri shell agree on the path without passing an env var.
 *
 *   macOS:   ~/Library/Application Support/<id>/
 *   Windows: %APPDATA%\<id>\   (= ~\AppData\Roaming\<id>)
 *   Linux:   $XDG_CONFIG_HOME/<id> or ~/.config/<id>
 */
function bundleIdToConfigDir(id: string): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', id);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData && appData.length > 0) return join(appData, id);
    return join(homedir(), 'AppData', 'Roaming', id);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, id);
  return join(homedir(), '.config', id);
}

/**
 * If the current Node binary lives inside a macOS .app bundle, return the
 * per-bundle config dir. This is the original macOS-only path; kept as-is
 * because Info.plist is authoritative on macOS (`package-bin.mjs` doesn't
 * own the .app layout — `tauri build` does).
 */
function appBundleConfigDir(): string | null {
  const match = process.execPath.match(/^(.*\.app)\/Contents\//);
  if (!match) return null;
  const appRoot = match[1];
  const plistPath = join(appRoot, 'Contents', 'Info.plist');
  if (!existsSync(plistPath)) return null;
  const plist = readFileSync(plistPath, 'utf8');
  const m = plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
  if (!m) return null;
  return join(homedir(), 'Library', 'Application Support', m[1]);
}

/**
 * Cross-platform sibling of `appBundleConfigDir`. Walks up from
 * `process.execPath` looking for a `morion-bundle-id.txt` sentinel file
 * dropped by `scripts/package-bin.mjs` at build time. The file carries a
 * single bundle identifier (e.g. `com.morion.Morion`). Once found, the
 * id is combined with the platform-appropriate user dir.
 *
 * Why a sentinel file instead of another path heuristic:
 *   - Windows has no `.app` convention; `process.execPath` inside the
 *     installed tree could sit anywhere (`%PROGRAMFILES%\Morion`,
 *     `%LOCALAPPDATA%\Programs\morion`, user-chosen dir via NSIS, etc.).
 *   - A marker file reliably distinguishes "packaged sidecar" from "dev
 *     tsx run" on every platform.
 *   - macOS keeps using Info.plist for its existing .app build because
 *     that path is authoritative there; this only kicks in where the
 *     .app path misses (Windows + Linux + standalone sidecar launches).
 */
function sidecarBundleConfigDir(): string | null {
  let dir = dirname(process.execPath);
  for (let depth = 0; depth < 6; depth += 1) {
    const marker = join(dir, 'morion-bundle-id.txt');
    if (existsSync(marker)) {
      try {
        const id = readFileSync(marker, 'utf8').trim();
        if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) return null;
        return bundleIdToConfigDir(id);
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the config dir based on the execution context. Four sources,
 * in precedence order:
 *
 *   1. `MORION_CONFIG_DIR` env var — always wins. Used by src-tauri/src/main.rs
 *      (explicit path from Tauri's app_config_dir) and by tests.
 *   2. Running inside a macOS .app bundle — derive from Info.plist bundle id.
 *      Gives the shipped `morion mcp` wrapper a working default with zero env.
 *   3. Running next to a `morion-bundle-id.txt` sentinel (Windows, Linux, and
 *      macOS standalone dist-bin tree) — derive from the sentinel + platform
 *      convention.
 *   4. Running from source / npm / plain node → `./data/` in the cwd.
 *      Dev-only, gitignored, isolates dev data from whatever a real user's
 *      prod app has written.
 *
 * The old `~/Library/Application Support/morion/` default (v0.93.x and
 * earlier) is gone on purpose — it was the bug that let two entry points
 * diverge into two databases.
 */
export function defaultConfigDir(): string {
  const env = process.env.MORION_CONFIG_DIR;
  if (env && env.length > 0) {
    return isAbsolute(env) ? env : resolve(process.cwd(), env);
  }
  const appDir = appBundleConfigDir();
  if (appDir) return appDir;
  const sidecarDir = sidecarBundleConfigDir();
  if (sidecarDir) return sidecarDir;
  return resolve(process.cwd(), 'data');
}

function resolveConfigPaths(): { configDir: string; configFile: string; defaultDbPath: string } {
  const configDir = defaultConfigDir();
  return {
    configDir,
    configFile: join(configDir, 'config.json'),
    defaultDbPath: join(configDir, 'morion.db'),
  };
}

/**
 * Apply env var overrides AFTER the schema parse so they win over whatever's
 * in the on-disk JSON file. Currently just `MORION_HTTP_PORT` (Tauri needs
 * to pin a free port if 7777 collides), but the pattern leaves room for
 * more knobs.
 */
function applyEnvOverrides(config: Config): Config {
  const portEnv = process.env.MORION_HTTP_PORT;
  if (portEnv && portEnv.length > 0) {
    const parsed = Number.parseInt(portEnv, 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return { ...config, httpPort: parsed };
    }
  }
  return config;
}

/**
 * Warn (loudly, to stderr) when `config.json` is world- or group-
 * writable or owned by a different user. The file controls `dbPath`
 * — an attacker who can rewrite it can redirect Morion at a
 * different SQLite DB without the user noticing. We don't throw
 * because that would make the app unbootable on an exotic mount
 * (e.g. SMB share where modes are lossy); the warning + manual
 * chmod is the pragmatic middle ground. See audit finding N23,
 * 2026-04-16.
 *
 * Not applicable on Windows — `process.getuid()` is undefined there
 * and POSIX modes are lies. Early return keeps this a Linux/macOS
 * check.
 */
function warnIfConfigUnsafe(configFile: string): void {
  if (process.platform === 'win32') return;
  const getuid = (process as unknown as { getuid?: () => number }).getuid;
  if (typeof getuid !== 'function') return;
  try {
    const st = statSync(configFile);
    const uid = getuid();
    if (st.uid !== uid) {
      process.stderr.write(
        `WARNING: ${configFile} is owned by uid=${st.uid}, not the current user ` +
          `(uid=${uid}). Anyone with that uid can redirect Morion to a different DB.\n`,
      );
    }
    // world- or group-writable = anyone in those buckets can edit
    // dbPath. 0o022 catches group-write + other-write in one AND.
    if ((st.mode & 0o022) !== 0) {
      process.stderr.write(
        `WARNING: ${configFile} is group- or world-writable (mode=${(st.mode & 0o777).toString(8)}). ` +
          `Run: chmod 600 "${configFile}"\n`,
      );
    }
  } catch {
    // stat() failing is handled by the existsSync caller — nothing
    // to warn about here.
  }
}

export function loadConfig(): Config {
  const { configFile, defaultDbPath } = resolveConfigPaths();
  if (!existsSync(configFile)) {
    return applyEnvOverrides(configSchema.parse({ dbPath: defaultDbPath }));
  }
  warnIfConfigUnsafe(configFile);
  const raw = JSON.parse(readFileSync(configFile, 'utf8')) as unknown;
  return applyEnvOverrides(configSchema.parse(raw));
}

export function saveConfig(config: Config): void {
  const { configFile } = resolveConfigPaths();
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
  // Brand-new file: own-user-only by default. chmod is a best-effort
  // safety net for POSIX systems; Windows ignores the mode bits
  // entirely, which is fine because Windows has its own ACLs.
  if (process.platform !== 'win32') {
    try {
      chmodSync(configFile, 0o600);
    } catch {
      // Some filesystems (SMB, network mounts) reject chmod. The
      // warning-on-read path in warnIfConfigUnsafe still catches
      // anything dangerous.
    }
  }
}

export function defaultConfig(): Config {
  const { defaultDbPath } = resolveConfigPaths();
  return applyEnvOverrides(configSchema.parse({ dbPath: defaultDbPath }));
}

export function configPaths(): { configFile: string; configDir: string; defaultDbPath: string } {
  const { configDir, configFile, defaultDbPath } = resolveConfigPaths();
  return { configFile, configDir, defaultDbPath: resolve(defaultDbPath) };
}
