import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { AttachmentsRepository } from '../src/core/attachments/repository.js';
import {
  ImportEngine,
  scanUploadedFile,
  scanUploadedFolder,
} from '../src/core/import/index.js';
import {
  convertDocxToMarkdown,
  DocxLegacyDocError,
  DocxTooLargeError,
  __test as docxTest,
} from '../src/core/import/formats/docx.js';

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  attachments: AttachmentsRepository;
  configDir: string;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const attachments = new AttachmentsRepository(handle.db);
  const configDir = mkdtempSync(join(tmpdir(), 'morion-docx-cfg-'));
  return { handle, notes, folders, attachments, configDir };
}

function cleanup(ctx: Ctx): void {
  ctx.handle.db.close();
  rmSync(ctx.configDir, { recursive: true, force: true });
}

/**
 * Build a minimal valid .docx in-memory by zipping a hardcoded
 * `[Content_Types].xml` + `word/document.xml`. Simpler than
 * shipping fixture .docx binaries through the repo.
 *
 * Uses macOS's native `zip` because Node has no zip in stdlib and
 * this test suite is macOS-only anyway (other tests skip non-darwin).
 */
function buildMinimalDocx(documentXmlBody: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'morion-docx-build-'));
  try {
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${documentXmlBody}</w:body>
</w:document>`;

    execSync(`mkdir -p "${dir}/_rels" "${dir}/word"`);
    require('node:fs').writeFileSync(join(dir, '[Content_Types].xml'), contentTypes);
    require('node:fs').writeFileSync(join(dir, '_rels', '.rels'), rels);
    require('node:fs').writeFileSync(join(dir, 'word', 'document.xml'), documentXml);
    const zipPath = join(tmpdir(), `morion-docx-${Date.now()}-${Math.random().toString(36).slice(2)}.docx`);
    execSync(`cd "${dir}" && zip -q -r "${zipPath}" .`);
    const buf = readFileSync(zipPath);
    rmSync(zipPath, { force: true });
    return buf;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('convertDocxToMarkdown — basics', () => {
  it('converts headings + paragraphs', async () => {
    const docx = buildMinimalDocx(`
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Hello World</w:t></w:r></w:p>
      <w:p><w:r><w:t>Body paragraph here.</w:t></w:r></w:p>
    `);
    const result = await convertDocxToMarkdown(docx);
    expect(result.markdown).toContain('# Hello World');
    expect(result.markdown).toContain('Body paragraph here');
  });

  it('converts bold + italic', async () => {
    const docx = buildMinimalDocx(`
      <w:p>
        <w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r>
        <w:r><w:t> and </w:t></w:r>
        <w:r><w:rPr><w:i/></w:rPr><w:t>italic</w:t></w:r>
      </w:p>
    `);
    const result = await convertDocxToMarkdown(docx);
    expect(result.markdown).toMatch(/\*\*bold\*\*/);
    expect(result.markdown).toMatch(/_italic_/);
  });

  it('rejects legacy .doc binary format', async () => {
    // OLE compound signature (the .doc magic bytes)
    const fakeDoc = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(100, 0),
    ]);
    await expect(convertDocxToMarkdown(fakeDoc)).rejects.toThrow(DocxLegacyDocError);
  });

  it('rejects files > 20 MB', async () => {
    const big = Buffer.alloc(21 * 1024 * 1024, 0);
    // First 2 bytes "PK" so we don't trip the legacy-doc check first
    big[0] = 0x50;
    big[1] = 0x4b;
    await expect(convertDocxToMarkdown(big)).rejects.toThrow(DocxTooLargeError);
  });

  it('rejects non-ZIP / non-OLE files', async () => {
    const garbage = Buffer.from('this is not a docx');
    await expect(convertDocxToMarkdown(garbage)).rejects.toThrow(/ZIP signature/);
  });
});

describe('convertDocxToMarkdown — post-processing', () => {
  it('strips `id`/`class`/`name` HTML attributes', () => {
    const out = docxTest.stripStrayHtmlAttrs(
      '<a id="x" href="https://x" class="foo">link</a>',
    );
    expect(out).not.toContain('id="x"');
    expect(out).not.toContain('class="foo"');
    expect(out).toContain('href="https://x"');
  });

  it('strips trailing footnote section', () => {
    const md = `Body text\n\nMore text\n\n[1] Footnote one\n[2] Footnote two\n`;
    const out = docxTest.stripFootnoteArtefacts(md);
    expect(out).not.toContain('Footnote one');
    expect(out).not.toContain('[1]');
  });

  it('strips inline `[1]` superscript markers', () => {
    const out = docxTest.stripFootnoteArtefacts('See note[1] for details');
    expect(out).toBe('See note for details');
  });
});

describe('engine integration — .docx via runFromUpload', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('imports a .docx single-file upload via runFromUpload', async () => {
    const docx = buildMinimalDocx(`
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>My Doc</w:t></w:r></w:p>
      <w:p><w:r><w:t>Hello from Word.</w:t></w:r></w:p>
    `);
    const engine = new ImportEngine(ctx.notes, ctx.folders, 'user', {
      attachments: ctx.attachments,
      configDir: ctx.configDir,
    });
    const summary = await engine.runFromUpload({
      mode: 'file',
      file: {
        relPath: 'mydoc.docx',
        bytes: docx.toString('base64'),
        encoding: 'base64',
      },
    });
    expect(summary.imported).toBe(1);
    // Mammoth may emit "unmapped style" warnings on minimal fixtures —
    // those land as `errored` per-file count but don't block the import.
    // We only care that the note was created.
    const all = ctx.notes.list({ limit: 100, offset: 0 });
    expect(all).toHaveLength(1);
    expect(all[0]?.title).toBe('My Doc');
    expect(all[0]?.body).toContain('Hello from Word');
  });

  it('mixed folder upload (.md + .docx) imports both', async () => {
    const docx = buildMinimalDocx(`
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Word Note</w:t></w:r></w:p>
    `);
    const engine = new ImportEngine(ctx.notes, ctx.folders, 'user', {
      attachments: ctx.attachments,
      configDir: ctx.configDir,
    });
    const summary = await engine.runFromUpload({
      mode: 'folder',
      files: [
        { relPath: 'MyVault/notes/markdown-note.md', bytes: '# Markdown Note\n\nText' },
        {
          relPath: 'MyVault/docs/word-note.docx',
          bytes: docx.toString('base64'),
          encoding: 'base64',
        },
      ],
    });
    expect(summary.imported).toBe(2);
    const titles = ctx.notes.list({ limit: 100, offset: 0 }).map((n) => n.title).sort();
    expect(titles).toEqual(['Markdown Note', 'Word Note']);
  });

  it('surfaces .docx legacy-doc error as a per-file warning, not a batch crash', async () => {
    const fakeDoc = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(50, 0),
    ]);
    const engine = new ImportEngine(ctx.notes, ctx.folders, 'user', {
      attachments: ctx.attachments,
      configDir: ctx.configDir,
    });
    // Folder mode with one valid .md + one broken .doc-as-.docx
    const summary = await engine.runFromUpload({
      mode: 'folder',
      files: [
        { relPath: 'V/good.md', bytes: '# Good' },
        {
          relPath: 'V/old.docx',
          bytes: fakeDoc.toString('base64'),
          encoding: 'base64',
        },
      ],
    });
    expect(summary.imported).toBe(1);
    expect(summary.errored).toBeGreaterThanOrEqual(1);
    expect(
      summary.errors.some((e) => e.message.includes('.doc binary format')),
    ).toBe(true);
  });
});

describe('scanUploadedFolder — extension allowlist includes .docx', () => {
  it('counts .docx files as supported', async () => {
    // Smoke — scanner should NOT throw on a docx-only folder once
    // mammoth conversion produces non-empty markdown.
    const docx = buildMinimalDocx(`
      <w:p><w:r><w:t>x</w:t></w:r></w:p>
    `);
    const r = await scanUploadedFolder([
      {
        relPath: 'V/sample.docx',
        bytes: docx.toString('base64'),
        encoding: 'base64',
      },
    ]);
    const fileEntries = r.entries.filter((e) => e.kind === 'file');
    expect(fileEntries).toHaveLength(1);
  });

  it('still rejects truly unsupported extensions', async () => {
    await expect(
      scanUploadedFile({ relPath: 'photo.heic', bytes: 'x' }),
    ).rejects.toThrow(/Unsupported/);
  });
});

