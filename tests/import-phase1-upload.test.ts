import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { ImportEngine, scanUploadedFile, scanUploadedFolder } from '../src/core/import/index.js';
import type { UploadedFile } from '../src/core/import/index.js';
import { __test as engineInternals } from '../src/core/import/engine.js';

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  return { handle, notes, folders };
}

function cleanup(ctx: Ctx): void {
  ctx.handle.db.close();
}

describe('scanUploadedFile — single file', () => {
  it('emits one entry with bytes pre-loaded', async () => {
    const r = await scanUploadedFile({ relPath: 'note.md', bytes: '# Hello' });
    expect(r.sourceRootName).toBeNull();
    expect(r.entries).toHaveLength(1);
    const e = r.entries[0]!;
    if (e.kind !== 'file') throw new Error('expected file entry');
    expect(e.relPath).toBe('note.md');
    expect(e.preReadBytes).toBe('# Hello');
    expect(e.parentRelPath).toBeNull();
  });

  it('rejects unsupported extensions', async () => {
    await expect(
      scanUploadedFile({ relPath: 'photo.png', bytes: 'fake' }),
    ).rejects.toThrow(/Unsupported file extension/);
  });

  it('accepts .markdown and .txt', async () => {
    await expect(
      scanUploadedFile({ relPath: 'a.markdown', bytes: 'x' }),
    ).resolves.toBeDefined();
    await expect(
      scanUploadedFile({ relPath: 'b.txt', bytes: 'y' }),
    ).resolves.toBeDefined();
  });
});

describe('scanUploadedFolder — folder structure', () => {
  it('builds entries with folder hierarchy + sourceRootName', async () => {
    const files: UploadedFile[] = [
      { relPath: 'MyVault/top.md', bytes: '# Top' },
      { relPath: 'MyVault/Projects/foo.md', bytes: '# Foo' },
      { relPath: 'MyVault/Projects/bar.md', bytes: '# Bar' },
      { relPath: 'MyVault/Projects/Sub/deep.md', bytes: '# Deep' },
    ];
    const r = await scanUploadedFolder(files);
    expect(r.sourceRootName).toBe('MyVault');

    // Folder entries (parent before child).
    const folderEntries = r.entries.filter((e) => e.kind === 'folder');
    const folderRels = folderEntries.map((e) => e.relPath);
    // Root '' first, then 'Projects', then 'Projects/Sub'.
    expect(folderRels).toEqual(['', 'Projects', 'Projects/Sub']);

    // File entries — relPath stripped of MyVault/ prefix.
    const fileEntries = r.entries.filter((e) => e.kind === 'file');
    const fileRels = fileEntries.map((e) => e.relPath).sort();
    expect(fileRels).toEqual([
      'Projects/Sub/deep.md',
      'Projects/bar.md',
      'Projects/foo.md',
      'top.md',
    ]);

    // parentRelPath correctly derived per file.
    const top = fileEntries.find((e) => e.relPath === 'top.md');
    if (top?.kind !== 'file') throw new Error('expected top.md as file');
    expect(top.parentRelPath).toBe('');
    const deep = fileEntries.find((e) => e.relPath === 'Projects/Sub/deep.md');
    if (deep?.kind !== 'file') throw new Error('expected deep.md as file');
    expect(deep.parentRelPath).toBe('Projects/Sub');
  });

  it('throws when no supported files', async () => {
    await expect(
      scanUploadedFolder([{ relPath: 'V/photo.png', bytes: 'fake' }]),
    ).rejects.toThrow(/no .md/);
  });

  it('throws on empty file list', async () => {
    await expect(scanUploadedFolder([])).rejects.toThrow(/no markdown files/);
  });

  it('skips unsupported files inside the folder silently', async () => {
    const files: UploadedFile[] = [
      { relPath: 'V/note.md', bytes: '# x' },
      { relPath: 'V/.DS_Store', bytes: 'noise' },
      { relPath: 'V/image.png', bytes: 'fake' },
    ];
    const r = await scanUploadedFolder(files);
    const fileEntries = r.entries.filter((e) => e.kind === 'file');
    expect(fileEntries).toHaveLength(1);
  });
});

describe('ImportEngine.runFromUpload — end-to-end', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('runs single-file upload and imports into null folder', async () => {
    const engine = new ImportEngine(ctx.notes, ctx.folders, 'user');
    const summary = await engine.runFromUpload({
      mode: 'file',
      file: { relPath: 'note.md', bytes: '# Hello\n\nWorld' },
    });
    expect(summary.imported).toBe(1);
    expect(summary.errored).toBe(0);
    expect(summary.rootFolderId).toBeNull();
    const all = ctx.notes.list({ limit: 100, offset: 0 });
    expect(all).toHaveLength(1);
    expect(all[0]?.title).toBe('Hello');
  });

  it('runs folder upload and creates Morion folder hierarchy', async () => {
    const engine = new ImportEngine(ctx.notes, ctx.folders, 'user');
    const summary = await engine.runFromUpload({
      mode: 'folder',
      files: [
        { relPath: 'MyVault/top.md', bytes: '# Top' },
        { relPath: 'MyVault/Projects/foo.md', bytes: '# Foo' },
        { relPath: 'MyVault/Projects/bar.md', bytes: '# Bar' },
      ],
    });
    expect(summary.imported).toBe(3);
    expect(summary.rootFolderId).not.toBeNull();
    const root = ctx.folders.getById(summary.rootFolderId!);
    expect(root?.name).toBe('MyVault');
    const projects = ctx.folders.getByName('Projects', root!.id);
    expect(projects).not.toBeNull();
    const foo = ctx.notes.list({ limit: 100, offset: 0 }).find((n) => n.title === 'Foo');
    expect(foo?.folderId).toBe(projects!.id);
  });

  it('preserves frontmatter through upload path', async () => {
    const engine = new ImportEngine(ctx.notes, ctx.folders, 'user');
    const md = `---
tags: [draft, ideas]
---

# Hello

body`;
    await engine.runFromUpload({
      mode: 'file',
      file: { relPath: 'note.md', bytes: md },
    });
    const n = ctx.notes.list({ limit: 100, offset: 0 })[0]!;
    expect([...n.tags].sort()).toEqual(['draft', 'ideas']);
  });

  it('sanitises script tags through upload path', async () => {
    const engine = new ImportEngine(ctx.notes, ctx.folders, 'user');
    await engine.runFromUpload({
      mode: 'file',
      file: { relPath: 'evil.md', bytes: '# X\n<script>alert(1)</script>' },
    });
    const n = ctx.notes.list({ limit: 100, offset: 0 })[0]!;
    expect(n.body).not.toContain('<script');
  });

  it('throws cleanly on empty folder upload', async () => {
    const engine = new ImportEngine(ctx.notes, ctx.folders, 'user');
    await expect(
      engine.runFromUpload({ mode: 'folder', files: [] }),
    ).rejects.toThrow(/no markdown files/);
  });
});

describe('runWithConcurrency — event-loop yield between items', () => {
  // Regression for ticket 01KQFG6926C70KC3TM6CAD2APQ. Without an
  // explicit yield, the worker loop runs N items synchronously (better-
  // sqlite3 + in-memory string ops never yield on their own); SSE
  // progress events emitted inside `worker` get coalesced into one TCP
  // chunk, and the import modal shows 0% → 100% with no intermediate
  // ticks. The yield is what makes incremental progress observable.
  it('lets external setImmediate callbacks interleave between items', async () => {
    const events: string[] = [];
    let observerFired = false;
    setImmediate(() => {
      observerFired = true;
      events.push('observer');
    });

    await engineInternals.runWithConcurrency(
      ['a', 'b', 'c'],
      1,
      async (item) => {
        events.push(item);
      },
      () => false,
    );

    expect(observerFired).toBe(true);
    // Without the per-iteration yield, the order would be
    // ['a','b','c','observer'] — the observer setImmediate sits in the
    // queue while the worker loop drains synchronously. With the
    // yield, 'observer' fires somewhere in the middle.
    const observerIdx = events.indexOf('observer');
    expect(observerIdx).toBeGreaterThanOrEqual(0);
    expect(observerIdx).toBeLessThan(events.length - 1);
  });
});
