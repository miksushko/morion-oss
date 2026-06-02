#!/usr/bin/env node
/**
 * Build the Morion MCP Bundle (.mcpb) for the Anthropic Desktop Extensions
 * directory.
 *
 * Output: `dist-mcpb/morion-<version>-darwin-arm64.mcpb`
 *
 * Contents (zip archive):
 *   manifest.json          (spec v0.3, declares server + 22 tools)
 *   icon.png               (copied from the app icon)
 *   server/
 *     index.js             (esbuild-bundled mcp-only entry)
 *     node_modules/
 *       better-sqlite3/    (keeps build/Release/better_sqlite3.node)
 *       sqlite-vec/        (JS shim)
 *       sqlite-vec-darwin-arm64/ (native .dylib)
 *
 * Why node_modules and not esbuild --bundle everything: the two native
 * deps ship prebuilt `.node` / `.dylib` files that Node resolves at
 * runtime via `require('better-sqlite3')`. esbuild can't bundle those
 * and keeping them as externals + shipping their package directories is
 * the Node-standard way.
 *
 * Annotations for all 22 tools are pulled from the live tool defs at
 * build time — can't drift.
 *
 * Target platform: darwin-arm64 only for the first submission. Add
 * darwin-x64 / win32-x64 / linux-x64 by rerunning this script with
 * different `--platform` / `--arch` args once we have demand.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, createWriteStream, createReadStream, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const PLATFORM = process.env.MCPB_PLATFORM ?? 'darwin-arm64'; // darwin-arm64 | darwin-x64 | win32-x64 | linux-x64
const OUT_DIR = join(root, 'dist-mcpb');
const STAGE = join(OUT_DIR, `stage-${PLATFORM}`);
const OUT_FILE = join(OUT_DIR, `morion-${pkg.version}-${PLATFORM}.mcpb`);

function log(msg) { process.stderr.write(`[mcpb] ${msg}\n`); }

// ---------- 1. Clean staging ----------
log(`version=${pkg.version} platform=${PLATFORM}`);
rmSync(STAGE, { recursive: true, force: true });
rmSync(OUT_FILE, { force: true });
mkdirSync(STAGE, { recursive: true });
mkdirSync(join(STAGE, 'server'), { recursive: true });

// ---------- helper: cross-platform npm-bin invocation ----------
// Running `node_modules/.bin/<name>` via spawnSync works on Unix
// (symlink → real binary or JS with shebang) but fails on Windows —
// the .bin folder has `.cmd` / `.ps1` shims, and spawn without
// `shell: true` can't invoke batch files. `shell: true` would
// word-split args containing spaces/semicolons (our esbuild
// `--banner:js=...` arg explodes).
//
// Fix: on Windows, invoke the package's JS entry directly through
// Node (node + node_modules/<pkg>/<jsEntryRelPath>). Both esbuild
// and tsx ship pure-JS entries that the Windows .cmd shim points at,
// so going through Node ourselves is equivalent + shell-agnostic.
const IS_WIN = process.platform === 'win32';
function spawnNpmBin(binName, jsEntryRelPath, args, opts = {}) {
  const cmd = IS_WIN
    ? process.execPath
    : join(root, 'node_modules', '.bin', binName);
  const spawnArgs = IS_WIN
    ? [join(root, 'node_modules', ...jsEntryRelPath.split('/')), ...args]
    : args;
  return spawnSync(cmd, spawnArgs, { cwd: root, ...opts });
}

// ---------- 2. esbuild bundle ----------
log('esbuild bundling mcp-only entry...');
const esbuildArgs = [
  'src/cli/mcp-only.ts',
    '--bundle',
    '--platform=node',
    '--target=node20',
    // Force Node's condition exports so packages like `ulid` serve their
    // node-crypto code path, not the browser UMD that hits Math.random.
    '--conditions=node',
    // Prefer ESM entries over UMD — `ulid`'s main is a UMD bundle whose
    // `detectPrng` gates on `typeof window/self/global` and explodes in
    // our esbuild-bundled ESM context. Its `module` field points at the
    // ESM build which is well-behaved.
    '--main-fields=module,main',
    // ESM output doesn't include a working `require` by default; bundled
    // libs that use CJS-style conditional loads (ulid's node-crypto
    // branch) explode. Banner injects `createRequire(import.meta.url)`
    // so those calls resolve properly at runtime.
    `--banner:js=import { createRequire as __mcpb_cr } from 'module'; const require = __mcpb_cr(import.meta.url);`,
    // ESM keeps `import.meta.url` functional — our `src/core/db/client.ts`
    // uses it to resolve the migrations directory relative to the file,
    // and CJS `import.meta` is undefined which blows up at module-load.
    '--format=esm',
    '--outfile=' + join(STAGE, 'server', 'index.mjs'),
    // Native modules stay as runtime requires — we ship their node_modules
    // directories alongside the bundle.
    '--external:better-sqlite3',
    '--external:sqlite-vec',
    // Everything transformers/ONNX/sharp-adjacent must NOT end up in the
    // bundle. With `runtime-slim.ts` the import tree doesn't pull them,
    // but belt-and-braces:
    '--external:@huggingface/transformers',
    '--external:onnxruntime-node',
    '--external:sharp',
    // Tauri bindings — again, not imported, but be explicit.
    '--external:@tauri-apps/api',
    '--external:@tauri-apps/plugin-deep-link',
    '--log-level=error',
];
const bundleRes = spawnNpmBin('esbuild', 'esbuild/bin/esbuild', esbuildArgs, {
  stdio: 'inherit',
});
if (bundleRes.error) {
  log(`esbuild spawn failed: ${bundleRes.error.message}`);
  process.exit(1);
}
if (bundleRes.status !== 0) {
  log(`esbuild exited with status ${bundleRes.status}`);
  process.exit(1);
}

// ---------- 2b. Copy migrations ----------
// DB schema migrations live as .sql files and are read at open time via
// `MORION_MIGRATIONS_DIR` or a path relative to client.ts. esbuild can't
// follow .sql `readFileSync` calls so we ship the raw files next to the
// bundle and point the runtime at them via env before spawn.
log('copying migrations...');
cpSync(
  join(root, 'src', 'core', 'db', 'migrations'),
  join(STAGE, 'server', 'migrations'),
  { recursive: true },
);

// ---------- 3. Copy native deps ----------
log('copying better-sqlite3 + sqlite-vec node_modules...');
const nodeModules = join(STAGE, 'server', 'node_modules');
mkdirSync(nodeModules, { recursive: true });

function copyPkg(name) {
  const src = join(root, 'node_modules', name);
  const dst = join(nodeModules, name);
  cpSync(src, dst, { recursive: true, dereference: true });
}
copyPkg('better-sqlite3');
// better-sqlite3 requires `bindings` at runtime (resolves the prebuilt
// .node binary across platform/arch/abi paths), and `bindings` requires
// `file-uri-to-path`. Both are pure JS, small, and must be on disk for
// Node's CJS resolver to find them when the esbuild-bundled require()
// call fires.
copyPkg('bindings');
copyPkg('file-uri-to-path');
copyPkg('sqlite-vec');

// Platform-specific sqlite-vec native payload. The npm package names don't
// match `process.platform-process.arch` verbatim — sqlite-vec uses
// `sqlite-vec-windows-x64` where Node would say `win32-x64`. Map our MCPB
// platform key to the published package names.
const VEC_PKG_BY_PLATFORM = {
  'darwin-arm64': 'sqlite-vec-darwin-arm64',
  'darwin-x64':   'sqlite-vec-darwin-x64',
  'linux-x64':    'sqlite-vec-linux-x64',
  'linux-arm64':  'sqlite-vec-linux-arm64',
  'win32-x64':    'sqlite-vec-windows-x64',
};
const vecPlatformPkg = VEC_PKG_BY_PLATFORM[PLATFORM];
if (!vecPlatformPkg) {
  log(`unsupported MCPB_PLATFORM=${PLATFORM} — sqlite-vec has no matching package`);
  process.exit(1);
}
if (!existsSync(join(root, 'node_modules', vecPlatformPkg))) {
  log(`missing node_modules/${vecPlatformPkg} — can't build for this platform`);
  process.exit(1);
}
copyPkg(vecPlatformPkg);

// ---------- 4. Copy icon ----------
log('copying icon...');
const iconCandidates = [
  join(root, 'src-tauri', 'icons', '128x128@2x.png'),
  join(root, 'src-tauri', 'icons', '128x128.png'),
  join(root, 'src-tauri', 'icons', '32x32.png'),
  // Non-tauri fallback so the open-source mirror (which ships no
  // src-tauri/) can still build the .mcpb. Same brand PNG, committed
  // under the web public dir.
  join(root, 'src', 'web', 'public', 'icon.png'),
];
const iconSrc = iconCandidates.find((p) => existsSync(p));
if (!iconSrc) {
  log('no icon found — set src/web/public/icon.png or src-tauri/icons/{128x128@2x,128x128,32x32}.png');
  process.exit(1);
}
cpSync(iconSrc, join(STAGE, 'icon.png'));

// ---------- 5. Extract live tool annotations ----------
log('extracting tool annotations...');
const mcpProbeRes = spawnNpmBin(
  'tsx',
  'tsx/dist/cli.mjs',
  [join(root, 'scripts', 'dump-tool-manifest.mjs')],
  { encoding: 'utf8' },
);
if (mcpProbeRes.error) {
  log(`dump-tool-manifest spawn failed: ${mcpProbeRes.error.message}`);
  process.exit(1);
}
if (mcpProbeRes.status !== 0) {
  log(`dump-tool-manifest exited with status ${mcpProbeRes.status}:\n${mcpProbeRes.stderr ?? '<no stderr>'}\n---stdout:\n${mcpProbeRes.stdout ?? '<no stdout>'}`);
  process.exit(1);
}
const toolManifest = JSON.parse(mcpProbeRes.stdout);
log(`  found ${toolManifest.length} tools`);

// ---------- 6. Write manifest.json ----------
log('writing manifest.json...');
const manifest = {
  manifest_version: '0.3',
  name: 'morion',
  display_name: 'Morion',
  version: pkg.version,
  description: 'Local-first notebook that doubles as a cross-LLM MCP memory server. Store notes once, access from Claude, Cursor, Cline, and any other MCP client.',
  long_description:
    'Morion is an Apple Notes-grade notebook that speaks MCP. Your notes live in a single local SQLite file — readable by any tool, exportable anywhere, never uploaded. This extension exposes 22 MCP tools so any LLM client can read, search, and write your notes alongside you. Unlike context-window memory, Morion has no size cap: store your full résumé, meeting transcripts, and hundreds of colleague notes without paying a token tax on every turn — the LLM retrieves only what it needs. Pair with the Morion desktop app (https://morion.ai) for a full GUI + per-folder AI access controls.',
  author: {
    name: 'Mikalai Sushko',
    email: 'mik@morion.ai',
    url: 'https://morion.ai',
  },
  homepage: 'https://morion.ai',
  documentation: 'https://morion.ai/mcp',
  support: 'https://morion.ai',
  privacy_policies: ['https://morion.ai/privacy'],
  icon: 'icon.png',
  repository: {
    type: 'git',
    url: 'https://github.com/miksushko/morion-releases',
  },
  license: 'Proprietary',
  keywords: ['notes', 'memory', 'local-first', 'markdown', 'sqlite', 'notebook'],
  server: {
    type: 'node',
    entry_point: 'server/index.mjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.mjs'],
    },
  },
  tools: toolManifest,
  compatibility: {
    claude_desktop: '>=0.10.0',
    platforms: [PLATFORM.startsWith('darwin') ? 'darwin' : PLATFORM.startsWith('win32') ? 'win32' : 'linux'],
    runtimes: {
      node: '>=20.0.0',
    },
  },
};
writeFileSync(join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// ---------- 7. Zip into .mcpb ----------
log('zipping...');
// macOS/Linux ship `zip` by default; Windows doesn't. Use `zip` when
// available (faster + preserves file modes), otherwise fall back to
// PowerShell `Compress-Archive` on Windows which is always present
// on any runnable Windows host from Windows 10 onwards.
mkdirSync(dirname(OUT_FILE), { recursive: true });
let zipRes;
if (IS_WIN) {
  // `Compress-Archive -Force` overwrites an existing archive. The
  // comma-separated `-Path` entries are relative to `$PWD` which we
  // set via `cwd: STAGE` so the archive root is flat (manifest.json
  // at root, server/ subdir, etc.) just like `zip` would produce.
  zipRes = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Compress-Archive -Force -Path 'manifest.json','icon.png','server' -DestinationPath '${OUT_FILE.replace(/\\/g, '/')}'`,
    ],
    { cwd: STAGE, stdio: 'inherit' },
  );
} else {
  zipRes = spawnSync(
    'zip',
    ['-rq', OUT_FILE, 'manifest.json', 'icon.png', 'server'],
    { cwd: STAGE, stdio: 'inherit' },
  );
}
if (zipRes.error) {
  log(`zip spawn failed: ${zipRes.error.message}`);
  process.exit(1);
}
if (zipRes.status !== 0) {
  log(`zip exited with status ${zipRes.status}`);
  process.exit(1);
}

// ---------- 8. Report ----------
const size = statSync(OUT_FILE).size;
const sha = createHash('sha256').update(readFileSync(OUT_FILE)).digest('hex');
const sizeMb = (size / 1024 / 1024).toFixed(2);
log(`done`);
log(`  file:  ${relative(root, OUT_FILE)}`);
log(`  size:  ${sizeMb} MB`);
log(`  sha256: ${sha}`);
