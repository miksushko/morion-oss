import type { Hono } from 'hono';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * HTTP endpoints serving the bundled `skills/morion/` tree.
 *
 * Why these exist (ticket `01KQFF7EE7VS0R7AA9B9WAH3RQ`): Tauri-side
 * Install button (`skill_install` IPC → `~/.claude/skills/morion/`)
 * only helps Claude Code users, and only in the desktop build. The
 * web/dev build couldn't surface ANY install affordance, and even
 * Tauri users running non-Claude agents (Codex CLI / Cursor / Cline)
 * had no download path — just a "copy this folder manually" hint
 * pointing at an internal bundled path most users never look at.
 *
 * These routes give every entry point a working download:
 *   - `GET /api/skills/morion/manifest`     → JSON descriptor
 *   - `GET /api/skills/morion/file?path=..` → individual file
 *   - `GET /api/skills/morion/bundle.zip`   → whole tree as ZIP
 *     (store-only, no external dep — minimal handcrafted writer
 *     below)
 *
 * Public surface — no auth gate change required; the existing
 * `/api/*` token check covers it.
 */

const SKILL_NAME = 'morion';

// Files inside the skill that we expose. Hardcoded so an attacker
// can't trick us into serving arbitrary paths via `?path=../../etc/passwd`.
const ALLOWED_FILES = [
  'SKILL.md',
  'references/mo-tools.md',
  'references/kanban-workflow.md',
];

let cachedSkillDir: string | null = null;

/**
 * Resolve `skills/morion/` from a few candidate locations:
 *   - `MORION_SKILLS_DIR` env override (used by tests + power users)
 *   - `<this file>/../../../../skills/morion`  (tsx dev: src/server/routes → repo root)
 *   - `<this file>/../../../skills/morion`     (compiled dist: dist/server/routes → repo root)
 *   - `<process.execPath>/resources/skills/morion` (Tauri sidecar bundle)
 */
function resolveSkillDir(): string | null {
  if (cachedSkillDir && existsSync(cachedSkillDir)) return cachedSkillDir;
  const envOverride = process.env.MORION_SKILLS_DIR;
  if (envOverride) {
    const abs = resolve(envOverride);
    if (existsSync(join(abs, 'SKILL.md'))) {
      cachedSkillDir = abs;
      return abs;
    }
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', '..', 'skills', SKILL_NAME), // tsx dev
    resolve(here, '..', '..', '..', '..', 'skills', SKILL_NAME), // compiled
    resolve(dirname(process.execPath), 'resources', 'skills', SKILL_NAME), // sidecar
    resolve(
      dirname(process.execPath),
      '..',
      'Resources',
      'resources',
      'skills',
      SKILL_NAME,
    ), // macOS .app
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'SKILL.md'))) {
      cachedSkillDir = candidate;
      return candidate;
    }
  }
  return null;
}

function parseSkillVersion(skillMdPath: string): string | null {
  try {
    const head = readFileSync(skillMdPath, 'utf8').slice(0, 800);
    // Frontmatter convention: `---\nversion: 1.0.0\n...`
    const match = head.match(/^[ \t]*version:[ \t]*["']?([^"'\r\n]+)["']?/m);
    return match ? match[1]!.trim() : null;
  } catch {
    return null;
  }
}

function buildManifest(skillDir: string) {
  const skillMd = join(skillDir, 'SKILL.md');
  const version = parseSkillVersion(skillMd);
  const files = ALLOWED_FILES.filter((rel) => existsSync(join(skillDir, rel))).map(
    (rel) => {
      const stat = statSync(join(skillDir, rel));
      return { path: rel, size: stat.size };
    },
  );
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  return { name: SKILL_NAME, version, files, totalSize };
}

// ---------- minimal store-only ZIP writer ----------
//
// Pure-Node, ~50 lines, no compression (store method = 0). Sufficient
// for a few small markdown files (~15 KB total) and avoids pulling
// `archiver` or `adm-zip` into the dependency tree.

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]!)! & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files: Array<{ path: string; bytes: Buffer }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const f of files) {
    // ZIP paths must use `/` (POSIX). Apple Notes / Windows handle it.
    const nameBuf = Buffer.from(f.path.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(f.bytes);
    const size = f.bytes.length;
    offsets.push(offset);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4); // version needed (2.0)
    lfh.writeUInt16LE(0x0800, 6); // bit flag — UTF-8 filename
    lfh.writeUInt16LE(0, 8); // method 0 = store
    lfh.writeUInt16LE(0, 10); // mod time (zero — we don't preserve)
    lfh.writeUInt16LE(0x21, 12); // mod date (1980-01-01 valid placeholder)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(size, 18);
    lfh.writeUInt32LE(size, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    local.push(lfh, nameBuf, f.bytes);
    offset += 30 + nameBuf.length + size;

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(0, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(size, 20);
    cdh.writeUInt32LE(size, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra
    cdh.writeUInt16LE(0, 32); // comment
    cdh.writeUInt16LE(0, 34); // disk number
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(offsets[offsets.length - 1]!, 42);
    central.push(cdh, nameBuf);
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...local, ...central, eocd]);
}

// ---------- routes ----------

export function registerSkillsRoutes(app: Hono): void {
  app.get('/api/skills/morion/manifest', (c) => {
    const dir = resolveSkillDir();
    if (!dir)
      return c.json(
        { error: 'skill_not_found', message: 'Bundled skill directory missing.' },
        404,
      );
    return c.json(buildManifest(dir));
  });

  app.get('/api/skills/morion/file', (c) => {
    const dir = resolveSkillDir();
    if (!dir)
      return c.json(
        { error: 'skill_not_found', message: 'Bundled skill directory missing.' },
        404,
      );
    const pathParam = c.req.query('path') ?? '';
    if (!ALLOWED_FILES.includes(pathParam))
      return c.json(
        { error: 'invalid_path', message: `Path not in allowlist: ${pathParam}` },
        400,
      );
    const abs = join(dir, pathParam);
    if (!existsSync(abs))
      return c.json(
        { error: 'file_not_found', message: pathParam },
        404,
      );
    const bytes = readFileSync(abs);
    // Hono's `c.body()` expects `Uint8Array<ArrayBuffer>` — Node's
    // `Buffer<ArrayBufferLike>` doesn't unify under TS strict because
    // ArrayBufferLike includes SharedArrayBuffer. Copy into a plain
    // Uint8Array (new ArrayBuffer-backed view) to satisfy the wire type.
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${pathParam.split('/').pop()}"`,
    });
  });

  app.get('/api/skills/morion/bundle.zip', (c) => {
    const dir = resolveSkillDir();
    if (!dir)
      return c.json(
        { error: 'skill_not_found', message: 'Bundled skill directory missing.' },
        404,
      );
    // Walk the actual tree (in case allowlist is later expanded by
    // adding files to the canonical source). Bound to ALLOWED_FILES
    // so an attacker can't sneak in arbitrary files via symlinks.
    const files: Array<{ path: string; bytes: Buffer }> = [];
    for (const rel of ALLOWED_FILES) {
      const abs = join(dir, rel);
      if (!existsSync(abs)) continue;
      const stat = statSync(abs);
      if (!stat.isFile()) continue;
      files.push({
        path: `${SKILL_NAME}/${rel}`, // unzips into a `morion/` folder
        bytes: readFileSync(abs),
      });
    }
    if (files.length === 0)
      return c.json(
        { error: 'skill_empty', message: 'No skill files found.' },
        404,
      );
    const zip = buildZip(files);
    // Same Buffer→Uint8Array cast as the /file endpoint above; see
    // comment there for the type-strict reason.
    return c.body(new Uint8Array(zip), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="morion-skill.zip"`,
      'Content-Length': String(zip.length),
    });
  });
}

// Internal helper for tests + diagnostic output. Not part of the route surface.
export const __test = { resolveSkillDir, buildManifest, buildZip, parseSkillVersion };

// `readdirSync` is imported but only used by the test helper layer if
// we extend ALLOWED_FILES dynamically later. Touch it to silence the
// unused-import linter without dropping the import (kept for future
// dynamic-walk variant).
void readdirSync;
