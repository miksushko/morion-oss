import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import {
  ImportEngine,
  ImportRegistry,
  FolderResolver,
  scanMarkdownFolder,
} from '../src/core/import/index.js';
import type { ImportEvent, ImportSummary } from '../src/core/import/index.js';

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  vault: string;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const vault = mkdtempSync(join(tmpdir(), 'morion-import-phase1-'));
  return { handle, notes, folders, vault };
}

function cleanup(ctx: Ctx): void {
  ctx.handle.db.close();
  rmSync(ctx.vault, { recursive: true, force: true });
}

function writeFile(vault: string, relPath: string, content: string): void {
  const full = join(vault, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

async function runEngine(
  ctx: Ctx,
  input: { absPath: string; mode: 'file' | 'folder' },
): Promise<{ summary: ImportSummary; events: ImportEvent[] }> {
  const engine = new ImportEngine(ctx.notes, ctx.folders, 'user');
  const events: ImportEvent[] = [];
  engine.events.on('event', (e: ImportEvent) => events.push(e));
  const summary = await engine.run(input);
  return { summary, events };
}

describe('Import Phase 1 — single .md file', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('imports one .md into the unfiled root (folderId=null)', async () => {
    writeFile(ctx.vault, 'note.md', '# My Note\n\nHello world.');
    const { summary } = await runEngine(ctx, {
      absPath: join(ctx.vault, 'note.md'),
      mode: 'file',
    });
    expect(summary.imported).toBe(1);
    expect(summary.errored).toBe(0);
    expect(summary.rootFolderId).toBeNull();
    const all = ctx.notes.list({ limit: 100, offset: 0 });
    expect(all).toHaveLength(1);
    expect(all[0]?.folderId).toBeNull();
    expect(all[0]?.title).toBe('My Note');
    expect(all[0]?.source).toBe('import:markdown');
  });

  it('derives title from filename when no H1 in body', async () => {
    writeFile(ctx.vault, 'plain.md', 'Just paragraph text.');
    await runEngine(ctx, { absPath: join(ctx.vault, 'plain.md'), mode: 'file' });
    const all = ctx.notes.list({ limit: 100, offset: 0 });
    expect(all[0]?.title).toBe('plain');
  });

  it('accepts .markdown and .txt extensions', async () => {
    writeFile(ctx.vault, 'a.markdown', '# A');
    writeFile(ctx.vault, 'b.txt', 'plain b');
    await runEngine(ctx, { absPath: join(ctx.vault, 'a.markdown'), mode: 'file' });
    await runEngine(ctx, { absPath: join(ctx.vault, 'b.txt'), mode: 'file' });
    const all = ctx.notes.list({ limit: 100, offset: 0 });
    expect(all.map((n) => n.title).sort()).toEqual(['A', 'b']);
  });

  it('rejects unsupported extensions', async () => {
    writeFile(ctx.vault, 'photo.png', 'fake');
    await expect(
      runEngine(ctx, { absPath: join(ctx.vault, 'photo.png'), mode: 'file' }),
    ).rejects.toThrow(/Unsupported file extension/);
  });
});

describe('Import Phase 1 — folder mode', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('creates a top-level folder named after the source folder', async () => {
    const src = join(ctx.vault, 'MyVault');
    writeFile(src, 'one.md', '# One');
    writeFile(src, 'two.md', '# Two');
    const { summary } = await runEngine(ctx, { absPath: src, mode: 'folder' });
    expect(summary.imported).toBe(2);
    expect(summary.rootFolderId).not.toBeNull();
    const root = ctx.folders.getById(summary.rootFolderId!);
    expect(root?.name).toBe('MyVault');
    expect(root?.parentId).toBeNull();
  });

  it('mirrors nested subfolder structure', async () => {
    const src = join(ctx.vault, 'Vault');
    writeFile(src, 'top.md', '# Top');
    writeFile(src, 'Projects/foo.md', '# Foo');
    writeFile(src, 'Projects/bar.md', '# Bar');
    writeFile(src, 'Projects/Sub/deep.md', '# Deep');
    const { summary } = await runEngine(ctx, { absPath: src, mode: 'folder' });
    expect(summary.imported).toBe(4);
    expect(summary.rootFolderId).not.toBeNull();
    const root = summary.rootFolderId!;

    const projects = ctx.folders.getByName('Projects', root);
    expect(projects).not.toBeNull();
    const sub = ctx.folders.getByName('Sub', projects!.id);
    expect(sub).not.toBeNull();

    // Notes should land in their respective folders.
    const allNotes = ctx.notes.list({ limit: 100, offset: 0 });
    const byTitle = (t: string) => allNotes.find((n) => n.title === t);
    expect(byTitle('Top')?.folderId).toBe(root);
    expect(byTitle('Foo')?.folderId).toBe(projects!.id);
    expect(byTitle('Bar')?.folderId).toBe(projects!.id);
    expect(byTitle('Deep')?.folderId).toBe(sub!.id);
  });

  it('two files in same source subfolder land in ONE Morion subfolder (no Projects (2))', async () => {
    const src = join(ctx.vault, 'Vault');
    writeFile(src, 'Projects/a.md', '# A');
    writeFile(src, 'Projects/b.md', '# B');
    const { summary } = await runEngine(ctx, { absPath: src, mode: 'folder' });
    expect(summary.imported).toBe(2);
    // Only ONE Projects folder under the root.
    const root = summary.rootFolderId!;
    const allFolders = ctx.folders.list();
    const projectsFolders = allFolders.filter(
      (f) => f.name.startsWith('Projects') && f.parentId === root,
    );
    expect(projectsFolders).toHaveLength(1);
    expect(projectsFolders[0]?.name).toBe('Projects');
  });

  it('top-level folder name collision appends (2), (3)', async () => {
    // Create a pre-existing root folder.
    ctx.folders.create('MyVault', null);
    const src = join(ctx.vault, 'MyVault');
    writeFile(src, 'note.md', '# Note');
    const { summary } = await runEngine(ctx, { absPath: src, mode: 'folder' });
    const root = ctx.folders.getById(summary.rootFolderId!);
    expect(root?.name).toBe('MyVault (2)');
  });

  it('duplicate note titles in same folder get (2), (3) suffix', async () => {
    // Pre-existing note with title "Foo" in null folder.
    ctx.notes.create({ body: '# Foo', source: 'user' }, 'user');
    writeFile(ctx.vault, 'foo.md', '# Foo\n\nNew content.');
    await runEngine(ctx, { absPath: join(ctx.vault, 'foo.md'), mode: 'file' });
    const all = ctx.notes.list({ limit: 100, offset: 0 });
    const titles = all.map((n) => n.title).sort();
    expect(titles).toContain('Foo');
    expect(titles).toContain('Foo (2)');
  });

  it('skips hidden files and unsupported extensions silently', async () => {
    const src = join(ctx.vault, 'V');
    writeFile(src, '.DS_Store', 'fake');
    writeFile(src, 'image.png', 'fake');
    writeFile(src, 'real.md', '# Real');
    const { summary } = await runEngine(ctx, { absPath: src, mode: 'folder' });
    expect(summary.imported).toBe(1);
    expect(summary.errored).toBe(0);
  });

  it('emits start, progress, and complete events with monotonic counts', async () => {
    const src = join(ctx.vault, 'V');
    writeFile(src, 'a.md', '# A');
    writeFile(src, 'b.md', '# B');
    writeFile(src, 'c.md', '# C');
    const { events, summary } = await runEngine(ctx, { absPath: src, mode: 'folder' });
    expect(events[0]?.type).toBe('start');
    expect(events[0]?.total).toBe(3);
    const completes = events.filter((e) => e.type === 'complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]?.summary).toEqual(summary);
    const progresses = events.filter((e) => e.type === 'progress');
    expect(progresses).toHaveLength(3);
    // done counter monotonic
    const dones = progresses.map((e) => e.done ?? 0);
    expect([...dones].sort()).toEqual(dones);
  });

  it('handles 50 files across 3 nested levels', async () => {
    const src = join(ctx.vault, 'Big');
    for (let i = 0; i < 20; i++) {
      writeFile(src, `top-${i}.md`, `# Top ${i}`);
    }
    for (let i = 0; i < 20; i++) {
      writeFile(src, `Projects/p-${i}.md`, `# P ${i}`);
    }
    for (let i = 0; i < 10; i++) {
      writeFile(src, `Projects/Deep/d-${i}.md`, `# D ${i}`);
    }
    const { summary } = await runEngine(ctx, { absPath: src, mode: 'folder' });
    expect(summary.imported).toBe(50);
    expect(summary.errored).toBe(0);
  });
});

describe('Import Phase 1 — registry (one-active invariant)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('reserve throws when another import is active', async () => {
    const registry = new ImportRegistry();
    const e1 = new ImportEngine(ctx.notes, ctx.folders, 'user');
    registry.reserve(e1);
    const e2 = new ImportEngine(ctx.notes, ctx.folders, 'user');
    expect(() => registry.reserve(e2)).toThrow(/already in progress/);
    registry.release(e1.id);
    expect(registry.isBusy()).toBe(false);
    // After release, second engine can reserve.
    expect(() => registry.reserve(e2)).not.toThrow();
  });

  it('buffers events for late subscribers', async () => {
    const registry = new ImportRegistry();
    const engine = new ImportEngine(ctx.notes, ctx.folders, 'user');
    registry.reserve(engine);
    writeFile(ctx.vault, 'note.md', '# X');
    await engine.run({ absPath: join(ctx.vault, 'note.md'), mode: 'file' });
    registry.release(engine.id);
    const buffered = registry.bufferedEvents(engine.id);
    expect(buffered.length).toBeGreaterThan(0);
    expect(buffered[0]?.type).toBe('start');
    expect(buffered[buffered.length - 1]?.type).toBe('complete');
  });
});

describe('Import Phase 1 — folder resolver', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('caches relPath → folderId so repeated lookups are stable', () => {
    const resolver = new FolderResolver(ctx.folders);
    resolver.createImportRoot('MyVault');
    const id1 = resolver.resolveForRelPath('Projects');
    const id2 = resolver.resolveForRelPath('Projects');
    expect(id1).toBe(id2);
  });

  it('creates intermediate folders for nested relPaths', () => {
    const resolver = new FolderResolver(ctx.folders);
    resolver.createImportRoot('Root');
    const deep = resolver.resolveForRelPath('A/B/C');
    expect(deep).not.toBeNull();
    const c = ctx.folders.getById(deep!);
    expect(c?.name).toBe('C');
    const b = ctx.folders.getById(c!.parentId!);
    expect(b?.name).toBe('B');
    const a = ctx.folders.getById(b!.parentId!);
    expect(a?.name).toBe('A');
  });
});

describe('Import Phase 1 — scanner', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('emits parent folder before child file in entry order', () => {
    const src = join(ctx.vault, 'V');
    writeFile(src, 'a/b/c.md', '# C');
    const result = scanMarkdownFolder(src);
    const folderIdx = result.entries.findIndex(
      (e) => e.kind === 'folder' && e.relPath === 'a/b',
    );
    const fileIdx = result.entries.findIndex(
      (e) => e.kind === 'file' && e.relPath === 'a/b/c.md',
    );
    expect(folderIdx).toBeGreaterThanOrEqual(0);
    expect(fileIdx).toBeGreaterThanOrEqual(0);
    expect(folderIdx).toBeLessThan(fileIdx);
  });
});

describe('Import Phase 1 — body length cap', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('rejects single file with body > 20k words without storing it', async () => {
    // 20k+1 words: `word ` repeated.
    const bigBody = '# Title\n\n' + Array(20_001).fill('word').join(' ');
    writeFile(ctx.vault, 'huge.md', bigBody);
    const { summary } = await runEngine(ctx, {
      absPath: join(ctx.vault, 'huge.md'),
      mode: 'file',
    });
    expect(summary.imported).toBe(0);
    expect(summary.errored).toBe(1);
    expect(summary.errors[0]?.message).toMatch(/exceeds the 20,000-word/);
    // No note row created.
    expect(ctx.notes.list({ limit: 100, offset: 0 })).toHaveLength(0);
  });

  it('accepts body at exactly the cap', async () => {
    // Exactly 20k words.
    const atCap = '# T\n\n' + Array(19_998).fill('word').join(' ');
    writeFile(ctx.vault, 'edge.md', atCap);
    const { summary } = await runEngine(ctx, {
      absPath: join(ctx.vault, 'edge.md'),
      mode: 'file',
    });
    expect(summary.imported).toBe(1);
    expect(summary.errored).toBe(0);
  });

  it('folder mode skips oversized files but imports the rest', async () => {
    const src = join(ctx.vault, 'V');
    writeFile(src, 'small.md', '# Small');
    writeFile(src, 'huge.md', '# T\n' + Array(21_000).fill('word').join(' '));
    writeFile(src, 'medium.md', '# Medium\n' + Array(500).fill('word').join(' '));
    const { summary } = await runEngine(ctx, { absPath: src, mode: 'folder' });
    expect(summary.imported).toBe(2);
    expect(summary.errored).toBe(1);
    expect(ctx.notes.list({ limit: 100, offset: 0 })).toHaveLength(2);
  });
});

describe('Import Phase 1 — cancel mid-import', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('cancel before run leaves nothing imported and emits cancelled', async () => {
    const src = join(ctx.vault, 'V');
    for (let i = 0; i < 5; i++) writeFile(src, `n${i}.md`, `# N${i}`);
    const engine = new ImportEngine(ctx.notes, ctx.folders, 'user', {
      fileConcurrency: 1,
    });
    const events: ImportEvent[] = [];
    engine.events.on('event', (e: ImportEvent) => events.push(e));
    // Cancel BEFORE run starts processing files. The engine should
    // honour the flag in the file-processing loop.
    engine.cancel();
    const summary = await engine.run({ absPath: src, mode: 'folder' });
    expect(summary.cancelled).toBe(true);
    expect(summary.imported).toBe(0);
    expect(events[events.length - 1]?.type).toBe('cancelled');
  });
});
