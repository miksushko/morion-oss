import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { AttachmentsRepository } from '../src/core/attachments/repository.js';
import {
  ImportEngine,
  scanMarkdownFolder,
} from '../src/core/import/index.js';
import {
  processInlineAttachments,
  __test as attachmentsTest,
} from '../src/core/import/attachments.js';

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  attachments: AttachmentsRepository;
  vault: string;
  configDir: string;
}

// Tiny PNG fixture (1x1 black pixel). Real magic bytes — passes
// fileTypeFromBuffer's PNG signature check.
const PNG_1X1_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
  'hex',
);

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const attachments = new AttachmentsRepository(handle.db);
  const vault = mkdtempSync(join(tmpdir(), 'morion-import-attach-vault-'));
  const configDir = mkdtempSync(join(tmpdir(), 'morion-import-attach-cfg-'));
  return { handle, notes, folders, attachments, vault, configDir };
}

function cleanup(ctx: Ctx): void {
  ctx.handle.db.close();
  rmSync(ctx.vault, { recursive: true, force: true });
  rmSync(ctx.configDir, { recursive: true, force: true });
}

function writeFile(vault: string, relPath: string, content: string | Buffer): void {
  const full = join(vault, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

describe('processInlineAttachments — direct module API', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('imports PNG referenced next to .md and rewrites the body link', async () => {
    writeFile(ctx.vault, 'note.md', '# X\n\n![alt](image.png)');
    writeFile(ctx.vault, 'image.png', PNG_1X1_BYTES);

    const result = await processInlineAttachments({
      body: '# X\n\n![alt](image.png)',
      sourceMdPath: join(ctx.vault, 'note.md'),
      importRoot: ctx.vault,
      configDir: ctx.configDir,
    });

    expect(result.pending).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
    expect(result.body).toMatch(/!\[alt\]\(morion:\/\/attachment\/[0-9A-Z]{26}\)/);
  });

  it('skips images outside the import root with warning', async () => {
    // ../traverse/evil.png — points outside ctx.vault.
    const traverseDir = mkdtempSync(join(tmpdir(), 'morion-traverse-'));
    writeFileSync(join(traverseDir, 'evil.png'), PNG_1X1_BYTES);
    try {
      writeFile(ctx.vault, 'note.md', '# X');
      const result = await processInlineAttachments({
        body: `# X\n\n![evil](${traverseDir}/evil.png)`,
        sourceMdPath: join(ctx.vault, 'note.md'),
        importRoot: ctx.vault,
        configDir: ctx.configDir,
      });
      expect(result.pending).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]?.message).toMatch(/outside the import root/);
    } finally {
      rmSync(traverseDir, { recursive: true, force: true });
    }
  });

  it('skips ../ traversal outside import root', async () => {
    writeFile(ctx.vault, 'sub/note.md', '# X');
    // Image at vault root — fine, inside root.
    writeFile(ctx.vault, 'image.png', PNG_1X1_BYTES);
    const okResult = await processInlineAttachments({
      body: '![](../image.png)',
      sourceMdPath: join(ctx.vault, 'sub/note.md'),
      importRoot: ctx.vault,
      configDir: ctx.configDir,
    });
    expect(okResult.pending).toHaveLength(1);
  });

  it('leaves https:// URLs alone (no warning, no download)', async () => {
    writeFile(ctx.vault, 'note.md', '# X');
    const result = await processInlineAttachments({
      body: '![](https://example.com/img.png)',
      sourceMdPath: join(ctx.vault, 'note.md'),
      importRoot: ctx.vault,
      configDir: ctx.configDir,
    });
    expect(result.pending).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.body).toContain('https://example.com/img.png');
  });

  it('warns and leaves morion://attachment/ refs alone', async () => {
    writeFile(ctx.vault, 'note.md', '# X');
    const result = await processInlineAttachments({
      body: '![](morion://attachment/01ABC123ABC123ABC123ABC123)',
      sourceMdPath: join(ctx.vault, 'note.md'),
      importRoot: ctx.vault,
      configDir: ctx.configDir,
    });
    expect(result.pending).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toMatch(/different Morion install/);
  });

  it('skips images > 10MB with warning', async () => {
    writeFile(ctx.vault, 'note.md', '# X');
    // Write an 11 MB file. Use the PNG signature so MIME sniff would
    // succeed if size cap weren't there.
    const big = Buffer.concat([
      PNG_1X1_BYTES,
      Buffer.alloc(11 * 1024 * 1024 - PNG_1X1_BYTES.length, 0),
    ]);
    writeFile(ctx.vault, 'huge.png', big);
    const result = await processInlineAttachments({
      body: '![](huge.png)',
      sourceMdPath: join(ctx.vault, 'note.md'),
      importRoot: ctx.vault,
      configDir: ctx.configDir,
    });
    expect(result.pending).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toMatch(/larger than 10 MB/);
  });

  it('skips non-image files with warning', async () => {
    writeFile(ctx.vault, 'note.md', '# X');
    writeFile(ctx.vault, 'document.pdf', 'not really a pdf');
    const result = await processInlineAttachments({
      body: '![](document.pdf)',
      sourceMdPath: join(ctx.vault, 'note.md'),
      importRoot: ctx.vault,
      configDir: ctx.configDir,
    });
    expect(result.pending).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toMatch(/Unsupported image format/);
  });

  it('handles missing image file with warning', async () => {
    writeFile(ctx.vault, 'note.md', '# X');
    const result = await processInlineAttachments({
      body: '![](missing.png)',
      sourceMdPath: join(ctx.vault, 'note.md'),
      importRoot: ctx.vault,
      configDir: ctx.configDir,
    });
    expect(result.pending).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });
});

describe('processInlineAttachments — isInsideRoot guard', () => {
  it('rejects sibling-prefix attempts', () => {
    expect(attachmentsTest.isInsideRoot('/Users/me/Vault2/x', '/Users/me/Vault')).toBe(false);
  });
  it('accepts path equal to root', () => {
    expect(attachmentsTest.isInsideRoot('/Users/me/Vault', '/Users/me/Vault')).toBe(true);
  });
  it('accepts path inside root', () => {
    expect(attachmentsTest.isInsideRoot('/Users/me/Vault/sub/file', '/Users/me/Vault')).toBe(true);
  });
});

describe('Phase 2 — engine integration: frontmatter + sanitize + attachments', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('Obsidian-vault import: frontmatter tags + dates + image attachment', async () => {
    const vault = join(ctx.vault, 'MyVault');
    const md = `---
title: Hello World
tags: [draft, kanban]
created: 2025-03-15
---

# Hello

![pic](photo.png)

Some content with <script>alert(1)</script> stripped.
`;
    writeFile(vault, 'note.md', md);
    writeFile(vault, 'photo.png', PNG_1X1_BYTES);

    const engine = new ImportEngine(ctx.notes, ctx.folders, 'user', {
      attachments: ctx.attachments,
      configDir: ctx.configDir,
    });
    const summary = await engine.run({ absPath: vault, mode: 'folder' });

    // Note created with frontmatter tags + ts.
    expect(summary.imported).toBe(1);
    const notes = ctx.notes.list({ limit: 100, offset: 0 });
    expect(notes).toHaveLength(1);
    const n = notes[0]!;
    expect(n.title).toBe('Hello World');
    expect([...n.tags].sort()).toEqual(['draft', 'kanban']);
    // created_at should match the frontmatter date (within tolerance).
    const expected = Date.parse('2025-03-15');
    expect(n.createdAt).toBe(expected);

    // Body has the script stripped.
    expect(n.body).not.toContain('<script');
    expect(n.body).not.toContain('alert(1)');

    // Body has the rewritten attachment URL.
    expect(n.body).toMatch(/!\[pic\]\(morion:\/\/attachment\/[0-9A-Z]{26}\)/);

    // Attachment row exists.
    const atts = ctx.attachments.listByNoteId(n.id);
    expect(atts).toHaveLength(1);
    expect(atts[0]?.mimeType).toBe('image/png');
    // File on disk.
    const onDisk = readFileSync(atts[0]!.filePath);
    expect(onDisk.length).toBe(PNG_1X1_BYTES.length);
  });

  it('falls back to filename when frontmatter has no title and body has no H1', async () => {
    writeFile(ctx.vault, 'plain-note.md', 'Just text, no title.');
    const engine = new ImportEngine(ctx.notes, ctx.folders, 'user');
    await engine.run({ absPath: join(ctx.vault, 'plain-note.md'), mode: 'file' });
    const notes = ctx.notes.list({ limit: 100, offset: 0 });
    expect(notes[0]?.title).toBe('plain-note');
  });

  it('event-handler attribute strip lands in stored body', async () => {
    writeFile(ctx.vault, 'evil.md', '# X\n\n<a href="https://x" onclick="alert(1)">click</a>');
    const engine = new ImportEngine(ctx.notes, ctx.folders, 'user');
    await engine.run({ absPath: join(ctx.vault, 'evil.md'), mode: 'file' });
    const n = ctx.notes.list({ limit: 100, offset: 0 })[0]!;
    expect(n.body).not.toContain('onclick');
    expect(n.body).toContain('href="https://x"');
  });

  it('engine without attachments repo skips image processing but still sanitises + frontmatter', async () => {
    writeFile(ctx.vault, 'note.md', '---\ntags: [a]\n---\n\n# X\n\n![](photo.png)\n<script>x()</script>');
    writeFile(ctx.vault, 'photo.png', PNG_1X1_BYTES);
    // No `attachments` / `configDir` passed — image refs survive as
    // plain markdown (broken link, but predictable).
    const engine = new ImportEngine(ctx.notes, ctx.folders, 'user');
    await engine.run({ absPath: join(ctx.vault, 'note.md'), mode: 'file' });
    const n = ctx.notes.list({ limit: 100, offset: 0 })[0]!;
    expect(n.body).not.toContain('<script');
    expect(n.body).toContain('![](photo.png)'); // unchanged
    expect(n.tags).toContain('a');
  });
});

describe('Phase 2 — scanner unaffected', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('subfolder ordering still respected with images present', async () => {
    const vault = join(ctx.vault, 'V');
    writeFile(vault, 'a.md', '# A\n![](pic-a.png)');
    writeFile(vault, 'pic-a.png', PNG_1X1_BYTES);
    writeFile(vault, 'sub/b.md', '# B\n![](pic-b.png)');
    writeFile(vault, 'sub/pic-b.png', PNG_1X1_BYTES);
    const result = scanMarkdownFolder(vault);
    // Only .md files end up as ImportEntryFile; PNG is not imported
    // by scanner — that's the engine's attachments pass.
    const fileEntries = result.entries.filter((e) => e.kind === 'file');
    expect(fileEntries).toHaveLength(2);
    expect(fileEntries.map((e) => e.relPath).sort()).toEqual(['a.md', 'sub/b.md']);
  });
});
