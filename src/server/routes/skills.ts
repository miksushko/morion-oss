import type { Hono } from 'hono';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * HTTP endpoints serving the bundled skill trees (`skills/<name>/`).
 *
 * Why these exist (ticket `01KQFF7EE7VS0R7AA9B9WAH3RQ`): Tauri-side
 * Install button (`skill_install` IPC → `~/.claude/skills/<name>/`)
 * only helps Claude Code users, and only in the desktop build. The
 * web/dev build couldn't surface ANY install affordance, and even
 * Tauri users running non-Claude agents (Codex CLI / Cursor / Cline)
 * had no download path.
 *
 * Multi-skill (Mo Workflows epic): routes
 * are parameterised on the skill name, gated by the SHIPPED_SKILLS
 * allowlist. Old `/api/skills/morion/*` URLs keep working — they match
 * the `:name` param.
 *
 *   - `GET /api/skills`                       → index of shipped skills
 *   - `GET /api/skills/:name/manifest`        → JSON descriptor
 *   - `GET /api/skills/:name/file?path=..`    → individual file
 *   - `GET /api/skills/:name/bundle.zip`      → whole tree as ZIP
 *     (store-only, no external dep — minimal handcrafted writer below)
 *
 * Public surface — no auth gate change required; the existing
 * `/api/*` token check covers it.
 */

/** Server-side copy of the shipped-skill list. Must stay in sync with
 *  `SHIPPED_SKILLS` in `scripts/prepare-skills.mjs` (build copy) and
 *  `src-tauri/src/skills/helpers.rs` (IPC install surface). */
const SHIPPED_SKILLS = ['morion', 'morion-workflows'] as const;

const cachedSkillDirs = new Map<string, string>();

/**
 * Resolve `skills/<name>/` from a few candidate locations:
 *   - `MORION_SKILLS_DIR` env override (tests + power users). Points at
 *     the skills ROOT (`<root>/<name>/SKILL.md`); a legacy value
 *     pointing directly at the morion dir still resolves for `morion`.
 *   - `<this file>/../../../skills/<name>`    (tsx dev: src/server/routes → repo root)
 *   - `<this file>/../../../../skills/<name>` (compiled dist: dist/server/routes → repo root)
 *   - `<process.execPath>/resources/skills/<name>` (Tauri sidecar bundle)
 */
function resolveSkillDir(name: string): string | null {
  const cached = cachedSkillDirs.get(name);
  if (cached && existsSync(cached)) return cached;
  const envOverride = process.env.MORION_SKILLS_DIR;
  if (envOverride) {
    const abs = resolve(envOverride);
    if (existsSync(join(abs, name, 'SKILL.md'))) {
      const dir = join(abs, name);
      cachedSkillDirs.set(name, dir);
      return dir;
    }
    // Legacy override semantics: the env var pointed directly at the
    // morion skill dir (pre-multi-skill). Honour it for morion only.
    if (name === 'morion' && existsSync(join(abs, 'SKILL.md'))) {
      cachedSkillDirs.set(name, abs);
      return abs;
    }
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', '..', 'skills', name), // tsx dev
    resolve(here, '..', '..', '..', '..', 'skills', name), // compiled
    resolve(dirname(process.execPath), 'resources', 'skills', name), // sidecar
    resolve(
      dirname(process.execPath),
      '..',
      'Resources',
      'resources',
      'skills',
      name,
    ), // macOS .app
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'SKILL.md'))) {
      cachedSkillDirs.set(name, candidate);
      return candidate;
    }
  }
  return null;
}

/**
 * Enumerate the servable files of a skill: a bounded recursive walk
 * that only surfaces regular `.md` files, skips dotfiles (the
 * installed-side `.morion-version` marker must never ship back out)
 * and symlinks (no way to escape the tree), and caps depth. The
 * `/file` endpoint only serves paths that appear in this list —
 * traversal via `?path=../../etc/passwd` can't match an enumerated
 * relative path.
 */
function listSkillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > 4) return;
    const entries = readdirSync(rel ? join(dir, rel) : dir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(childRel, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(childRel);
      }
    }
  };
  walk('', 0);
  return out.sort();
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

function buildManifest(skillDir: string, name: string) {
  const skillMd = join(skillDir, 'SKILL.md');
  const version = parseSkillVersion(skillMd);
  const files = listSkillFiles(skillDir).map((rel) => {
    const stat = statSync(join(skillDir, rel));
    return { path: rel, size: stat.size };
  });
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  return { name, version, files, totalSize };
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

function skillNameFromParam(raw: string): string | null {
  return (SHIPPED_SKILLS as readonly string[]).includes(raw) ? raw : null;
}

export function registerSkillsRoutes(app: Hono): void {
  app.get('/api/skills', (c) => {
    const skills = SHIPPED_SKILLS.map((name) => {
      const dir = resolveSkillDir(name);
      if (!dir) return { name, available: false as const };
      return { available: true as const, ...buildManifest(dir, name) };
    });
    return c.json({ skills });
  });

  app.get('/api/skills/:name/manifest', (c) => {
    const name = skillNameFromParam(c.req.param('name'));
    if (!name)
      return c.json(
        { error: 'skill_not_found', message: 'Unknown skill name.' },
        404,
      );
    const dir = resolveSkillDir(name);
    if (!dir)
      return c.json(
        { error: 'skill_not_found', message: 'Bundled skill directory missing.' },
        404,
      );
    return c.json(buildManifest(dir, name));
  });

  app.get('/api/skills/:name/file', (c) => {
    const name = skillNameFromParam(c.req.param('name'));
    if (!name)
      return c.json(
        { error: 'skill_not_found', message: 'Unknown skill name.' },
        404,
      );
    const dir = resolveSkillDir(name);
    if (!dir)
      return c.json(
        { error: 'skill_not_found', message: 'Bundled skill directory missing.' },
        404,
      );
    const pathParam = c.req.query('path') ?? '';
    // Exact match against the enumerated tree — the only way a path is
    // servable is to literally appear in the bounded walk, so `../`
    // tricks and absolute paths can never match.
    if (!listSkillFiles(dir).includes(pathParam))
      return c.json(
        { error: 'invalid_path', message: `Path not in skill tree: ${pathParam}` },
        400,
      );
    const bytes = readFileSync(join(dir, pathParam));
    // Hono's `c.body()` expects `Uint8Array<ArrayBuffer>` — Node's
    // `Buffer<ArrayBufferLike>` doesn't unify under TS strict because
    // ArrayBufferLike includes SharedArrayBuffer. Copy into a plain
    // Uint8Array (new ArrayBuffer-backed view) to satisfy the wire type.
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${pathParam.split('/').pop()}"`,
    });
  });

  app.get('/api/skills/:name/bundle.zip', (c) => {
    const name = skillNameFromParam(c.req.param('name'));
    if (!name)
      return c.json(
        { error: 'skill_not_found', message: 'Unknown skill name.' },
        404,
      );
    const dir = resolveSkillDir(name);
    if (!dir)
      return c.json(
        { error: 'skill_not_found', message: 'Bundled skill directory missing.' },
        404,
      );
    const files: Array<{ path: string; bytes: Buffer }> = [];
    for (const rel of listSkillFiles(dir)) {
      files.push({
        path: `${name}/${rel}`, // unzips into a `<name>/` folder
        bytes: readFileSync(join(dir, rel)),
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
      'Content-Disposition': `attachment; filename="${name}-skill.zip"`,
      'Content-Length': String(zip.length),
    });
  });
}

// Internal helper for tests + diagnostic output. Not part of the route surface.
export const __test = {
  resolveSkillDir,
  buildManifest,
  buildZip,
  parseSkillVersion,
  listSkillFiles,
  _resetCache: (): void => {
    cachedSkillDirs.clear();
  },
};
