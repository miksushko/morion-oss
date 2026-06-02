/**
 * Single source of truth for the app version. Read once at module
 * load from the nearest `package.json` walking up from THIS file, and
 * cached for every subsequent import.
 *
 * Every Node-side surface (HTTP /api/health, CLI --version, any log
 * line) reads from here. `package.json` is the ONLY place the version
 * string lives — see `tasks/lessons.md` 2026-04-16 "Version
 * source-of-truth is exactly one place". `tauri.conf.json` and
 * `src-tauri/Cargo.toml` carry their own copies for the Rust shell's
 * bundle metadata; keep those in sync via the release process, not
 * at runtime.
 *
 * Why walk-up and not a hardcoded relative path: the file path from
 * `version.ts` to `package.json` differs between build layouts.
 *
 *   Dev (tsx):                src/core/version.ts         → ../../package.json
 *   Compiled (dist/):         dist/core/version.js         → ../../package.json
 *   Packaged sidecar (app/):  app/core/version.js          → ../package.json
 *   .app bundle:              Resources/.../app/core/...  → ../package.json
 *
 * Hardcoding `../../package.json` (as an earlier cut of this file
 * did) breaks the packaged sidecar because `app/` is only one level
 * above `core/`, not two — the require fails on import, which takes
 * the whole sidecar down before `/api/health` can respond. The user
 * sees "nothing works" because the sidecar never starts. Regression
 * fixed 2026-04-17 after a v0.99.4 installer wouldn't launch.
 */
// ⚠️  DO NOT change the walk-up to a hardcoded relative path
// (e.g. `require('../../package.json')`) without reading
// tasks/lessons.md 2026-04-17 "Relative paths in compiled sources
// break when the file tree is restacked". The TL;DR: this file
// ships in four different directory layouts and the depth from
// `version.{ts,js}` to `package.json` is NOT CONSTANT across them.
// A hardcoded path works in dev + dist/ but silently breaks the
// packaged sidecar — the sidecar crashes on module load and the
// user sees "nothing works" because the HTTP server never binds.
// This has happened before (v0.99.4 installer was born dead). The
// walk-up resolver is the ONE shape that works in every layout.
// If you're reaching for a "simpler" rewrite, it's not simpler —
// it's the trap that ate a full release cycle.

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * Walk up from `start` looking for a directory that contains
 * `package.json`. Bounded to 10 hops so a symlink loop or weird FS
 * can't burn CPU. Throws if none found — surfacing at module load,
 * not at runtime, matches the "fail fast" intent.
 *
 * DO NOT "optimise" this to a single relative path. See the file
 * header comment above. The hops are:
 *   dev:        src/core/ → src/ → repo-root  (finds on hop 2)
 *   dist:       dist/core/ → dist/ → repo-root  (finds on hop 2)
 *   dist-bin:   app/core/ → app/  (finds on hop 1, slim package.json)
 *   .app:       <bundle>/.../sidecar/app/core/ → sidecar/app/
 *               (finds on hop 1)
 *
 * If a test harness places this file in a directory with NO
 * package.json anywhere above it, the function throws — that's
 * correct. Don't catch-and-default here; silently defaulting the
 * version to `'0.0.0'` would mask packaging bugs, and any caller
 * using the returned string would print something misleading.
 */
function findPackageJson(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    const candidate = `${dir}/package.json`;
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // hit filesystem root
    dir = parent;
  }
  throw new Error(`package.json not found walking up from ${start}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const pkg = require(findPackageJson(here)) as { version: string };

export const APP_VERSION: string = pkg.version;
