import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { VecIndex } from '../src/core/search/vec.js';
import { Indexer } from '../src/core/search/indexer.js';
import { NoopEmbeddings } from '../src/core/embeddings/noop.js';
import { MarkdownImporter } from '../src/core/importers/markdown.js';

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  importer: MarkdownImporter;
  vault: string;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  const indexer = new Indexer(vec, embeddings);
  const importer = new MarkdownImporter(notes, folders, indexer);
  const vault = mkdtempSync(join(tmpdir(), 'morion-import-'));
  return { handle, notes, folders, importer, vault };
}

function writeFile(vault: string, relPath: string, content: string): void {
  const full = join(vault, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

describe('MarkdownImporter', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    rmSync(ctx.vault, { recursive: true, force: true });
    ctx.handle.db.close();
  });

  it('imports a root-level note into Inbox (folder = null)', async () => {
    writeFile(ctx.vault, 'hello.md', '# Hello\n\nbody text');

    const summary = await ctx.importer.import({ vaultPath: ctx.vault });

    expect(summary).toMatchObject({ scanned: 1, imported: 1, skipped: 0 });
    expect(summary.errors).toEqual([]);

    const notes = ctx.notes.list({ limit: 50, offset: 0 });
    expect(notes).toHaveLength(1);
    // Title = filename stem (no frontmatter title), merged into body by repo
    expect(notes[0]!.title).toBe('hello');
    expect(notes[0]!.folderId).toBeNull();
    // Body already starts with a heading, and repo merges title 'hello' before it
    expect(notes[0]!.body).toBe('# hello\n\n# Hello\n\nbody text');
    expect(notes[0]!.source).toBe('import:markdown');
  });

  it('imports a nested note into a folder named after the first path segment', async () => {
    writeFile(ctx.vault, 'work/meeting.md', '# Meeting notes\n\nstuff');

    await ctx.importer.import({ vaultPath: ctx.vault });

    const folders = ctx.folders.list();
    expect(folders).toHaveLength(1);
    expect(folders[0]!.name).toBe('work');

    const notes = ctx.notes.list({ folderId: folders[0]!.id, limit: 50, offset: 0 });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe('meeting');
  });

  it('collapses deeply nested files to their top-level segment', async () => {
    writeFile(ctx.vault, 'work/projects/alpha/spec.md', 'spec content');

    await ctx.importer.import({ vaultPath: ctx.vault });

    const folders = ctx.folders.list();
    expect(folders).toHaveLength(1);
    expect(folders[0]!.name).toBe('work');
  });

  it('uses frontmatter.title when present and strips frontmatter from body', async () => {
    writeFile(
      ctx.vault,
      'note.md',
      '---\ntitle: My Real Title\n---\n\nbody after fm',
    );

    await ctx.importer.import({ vaultPath: ctx.vault });

    const notes = ctx.notes.list({ limit: 50, offset: 0 });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe('My Real Title');
    // Repo merges title into body since body doesn't start with it
    expect(notes[0]!.body).toBe('# My Real Title\n\nbody after fm');
  });

  it('parses tags from frontmatter array form', async () => {
    writeFile(
      ctx.vault,
      'note.md',
      '---\ntags: [alpha, beta, gamma]\n---\n\nbody',
    );

    await ctx.importer.import({ vaultPath: ctx.vault });

    const notes = ctx.notes.list({ limit: 50, offset: 0 });
    expect(notes[0]!.tags).toEqual(['alpha', 'beta', 'gamma']);
    // title derived from filename, merged into body
    expect(notes[0]!.title).toBe('note');
  });

  it('parses tags from frontmatter comma-separated string form', async () => {
    writeFile(
      ctx.vault,
      'note.md',
      '---\ntags: alpha, beta, gamma\n---\n\nbody',
    );

    await ctx.importer.import({ vaultPath: ctx.vault });

    const notes = ctx.notes.list({ limit: 50, offset: 0 });
    expect(notes[0]!.tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('skips duplicates on re-run (idempotent)', async () => {
    writeFile(ctx.vault, 'a.md', 'aaa');
    writeFile(ctx.vault, 'b.md', 'bbb');

    const first = await ctx.importer.import({ vaultPath: ctx.vault });
    expect(first).toMatchObject({ scanned: 2, imported: 2, skipped: 0 });

    const second = await ctx.importer.import({ vaultPath: ctx.vault });
    expect(second).toMatchObject({ scanned: 2, imported: 0, skipped: 2 });

    const notes = ctx.notes.list({ limit: 50, offset: 0 });
    expect(notes).toHaveLength(2);
  });

  it('reuses an existing folder by name on re-run instead of duplicating', async () => {
    writeFile(ctx.vault, 'work/a.md', 'aaa');

    await ctx.importer.import({ vaultPath: ctx.vault });

    // Add a brand-new file in the same folder, then re-run.
    writeFile(ctx.vault, 'work/b.md', 'bbb');
    const second = await ctx.importer.import({ vaultPath: ctx.vault });

    expect(second).toMatchObject({ imported: 1, skipped: 1 });
    expect(ctx.folders.list()).toHaveLength(1);
  });

  it('ignores hidden files and non-markdown files', async () => {
    writeFile(ctx.vault, 'visible.md', 'visible');
    writeFile(ctx.vault, '.hidden.md', 'hidden');
    writeFile(ctx.vault, 'image.png', 'binary');
    writeFile(ctx.vault, '.git/config', 'should not be walked');

    const summary = await ctx.importer.import({ vaultPath: ctx.vault });

    expect(summary.scanned).toBe(1);
    expect(summary.imported).toBe(1);
  });

  it('falls back to filename stem when no frontmatter title is present', async () => {
    writeFile(ctx.vault, 'kebab-case-name.md', 'no fm here');

    await ctx.importer.import({ vaultPath: ctx.vault });

    const notes = ctx.notes.list({ limit: 50, offset: 0 });
    expect(notes[0]!.title).toBe('kebab-case-name');
    // Repo merged the title into body
    expect(notes[0]!.body).toBe('# kebab-case-name\n\nno fm here');
  });

  it('preserves a custom source string when provided', async () => {
    writeFile(ctx.vault, 'a.md', 'aaa');

    await ctx.importer.import({ vaultPath: ctx.vault, source: 'import:obsidian-vault-1' });

    const notes = ctx.notes.list({ limit: 50, offset: 0 });
    expect(notes[0]!.source).toBe('import:obsidian-vault-1');
  });
});
