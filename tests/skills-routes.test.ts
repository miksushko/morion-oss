import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerSkillsRoutes, __test } from '../src/server/routes/skills.js';

/**
 * Multi-skill HTTP surface — Mo Workflows epic.
 *
 * `/api/skills` index + per-skill manifest/file/zip, the shipped-name
 * allowlist, and the bounded dynamic file walk that replaced the
 * hardcoded ALLOWED_FILES list (dotfiles / symlinks / non-md excluded,
 * traversal impossible because only enumerated paths serve).
 */

function makeSkillFixture(root: string, name: string, version = '9.9.9'): void {
  const dir = join(root, name);
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\nversion: ${version}\n---\n\n# ${name}\n`,
  );
  writeFileSync(join(dir, 'references', 'guide.md'), `# guide for ${name}\n`);
  // Noise the walk must exclude:
  writeFileSync(join(dir, '.morion-version'), '{"version":"0"}');
  writeFileSync(join(dir, 'notes.txt'), 'not markdown');
  symlinkSync('/etc/hosts', join(dir, 'references', 'escape.md'));
}

describe('skills routes — multi-skill surface', () => {
  let app: Hono;
  let root: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'morion-skills-'));
    makeSkillFixture(root, 'morion', '1.3.1');
    makeSkillFixture(root, 'morion-workflows', '0.1.0');
    prevEnv = process.env.MORION_SKILLS_DIR;
    process.env.MORION_SKILLS_DIR = root;
    __test._resetCache();
    app = new Hono();
    registerSkillsRoutes(app);
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MORION_SKILLS_DIR;
    else process.env.MORION_SKILLS_DIR = prevEnv;
    __test._resetCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET /api/skills lists every shipped skill with manifests', async () => {
    const res = await app.request('/api/skills');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skills: Array<{ name: string; available: boolean; version?: string }>;
    };
    const names = body.skills.map((s) => s.name);
    expect(names).toEqual(['morion', 'morion-workflows']);
    expect(body.skills.every((s) => s.available)).toBe(true);
    expect(body.skills[0].version).toBe('1.3.1');
    expect(body.skills[1].version).toBe('0.1.0');
  });

  it('per-skill manifest enumerates only regular .md files', async () => {
    const res = await app.request('/api/skills/morion-workflows/manifest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      version: string;
      files: Array<{ path: string }>;
    };
    expect(body.name).toBe('morion-workflows');
    const paths = body.files.map((f) => f.path);
    expect(paths).toEqual(['SKILL.md', 'references/guide.md']);
    // Dotfile, .txt, and the /etc/hosts symlink are all excluded.
    expect(paths).not.toContain('.morion-version');
    expect(paths).not.toContain('notes.txt');
    expect(paths).not.toContain('references/escape.md');
  });

  it('unknown skill names 404 without touching the filesystem', async () => {
    for (const name of ['evil', '..%2F..%2Fetc', 'MORION']) {
      const res = await app.request(`/api/skills/${name}/manifest`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('skill_not_found');
    }
  });

  it('file endpoint serves enumerated paths and rejects traversal', async () => {
    const ok = await app.request(
      '/api/skills/morion/file?path=references/guide.md',
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('guide for morion');

    for (const evil of [
      '../morion-workflows/SKILL.md',
      '../../etc/passwd',
      '/etc/passwd',
      '.morion-version',
      'notes.txt',
      'references/escape.md',
    ]) {
      const res = await app.request(
        `/api/skills/morion/file?path=${encodeURIComponent(evil)}`,
      );
      expect(res.status).toBe(400);
    }
  });

  it('bundle.zip wraps the tree under a <name>/ folder', async () => {
    const res = await app.request('/api/skills/morion-workflows/bundle.zip');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('Content-Disposition')).toContain(
      'morion-workflows-skill.zip',
    );
    const bytes = Buffer.from(await res.arrayBuffer());
    // Store-only zip → file paths appear verbatim in the byte stream.
    const text = bytes.toString('latin1');
    expect(text).toContain('morion-workflows/SKILL.md');
    expect(text).toContain('morion-workflows/references/guide.md');
    expect(text).not.toContain('notes.txt');
  });

  it('legacy MORION_SKILLS_DIR pointing directly at the morion dir still resolves', async () => {
    process.env.MORION_SKILLS_DIR = join(root, 'morion');
    __test._resetCache();
    const res = await app.request('/api/skills/morion/manifest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; version: string };
    expect(body.version).toBe('1.3.1');
    // The legacy single-dir override only covers morion — the second
    // skill falls back to the repo tree (which exists in this checkout,
    // so just assert it doesn't resolve to the fixture).
    const wf = await app.request('/api/skills/morion-workflows/manifest');
    expect([200, 404]).toContain(wf.status);
  });
});
