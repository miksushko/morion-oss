import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import {
  scanAppleNotesExport,
  htmlToMarkdown,
  extractInlineImages,
  ImportEngine,
} from '../src/core/import/index.js';
import type { AppleNotesExportResult } from '../src/core/import/index.js';

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

describe('htmlToMarkdown — Apple Notes HTML conversion', () => {
  it('converts headings + paragraphs', () => {
    const md = htmlToMarkdown('<h1>Title</h1><p>Para</p>');
    expect(md).toContain('# Title');
    expect(md).toContain('Para');
  });

  it('converts bold + italic', () => {
    const md = htmlToMarkdown('<p><b>bold</b> and <i>ital</i></p>');
    expect(md).toMatch(/\*\*bold\*\*/);
    expect(md).toMatch(/_ital_/);
  });

  it('converts ordered + unordered lists', () => {
    const md = htmlToMarkdown('<ul><li>a</li><li>b</li></ul>');
    expect(md).toMatch(/-\s+a/);
    expect(md).toMatch(/-\s+b/);
  });

  it('converts links', () => {
    const md = htmlToMarkdown('<a href="https://x.com">link</a>');
    expect(md).toBe('[link](https://x.com)');
  });

  it('handles empty body', () => {
    expect(htmlToMarkdown('')).toBe('');
  });

  it('strips <object> and <embed>', () => {
    const md = htmlToMarkdown('<p>hi</p><object data="x">drop</object><embed src="y">');
    expect(md).not.toContain('<object');
    expect(md).not.toContain('<embed');
    expect(md).toContain('hi');
  });

  it('converts <table> to GFM markdown via turndown-plugin-gfm', () => {
    // Apple Notes encodes its tables as standard HTML <table>; without
    // the GFM plugin loaded, turndown silently flattens this into a
    // run-on text blob and the table is lost on import. Pin the
    // contract so we don't drop the plugin during a future refactor.
    const html =
      '<table><thead><tr><th>A</th><th>B</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>';
    const md = htmlToMarkdown(html);
    // turndown-plugin-gfm pads cells for column alignment, hence the
    // tolerant `\s+` in the regexes below.
    expect(md).toMatch(/\|\s*A\s*\|\s*B\s*\|/);
    expect(md).toMatch(/\|\s*---\s*\|\s*---\s*\|/);
    expect(md).toMatch(/\|\s*1\s*\|\s*2\s*\|/);
    expect(md).toMatch(/\|\s*3\s*\|\s*4\s*\|/);
  });
});

describe('scanAppleNotesExport — folder/file structure', () => {
  it('mounts each picked folder at root by leaf name (no account/path wrapper)', () => {
    const exportResult: AppleNotesExportResult = {
      notes: [
        {
          accountName: 'iCloud',
          folderPath: 'Notes',
          name: 'Hello',
          bodyHtml: '<p>Hi</p>',
          createdAt: 1700000000000,
          modifiedAt: 1700000001000,
          pinned: false,
        },
        {
          accountName: 'iCloud',
          folderPath: 'Projects/Foo',
          name: 'Project Note',
          bodyHtml: '<h2>Sub</h2>',
          createdAt: 1700000002000,
          modifiedAt: 1700000003000,
          pinned: true,
        },
        {
          accountName: 'On My Mac',
          folderPath: 'Personal',
          name: 'Local note',
          bodyHtml: '<p>local</p>',
          createdAt: 1700000004000,
          modifiedAt: 1700000005000,
          pinned: false,
        },
      ],
      skippedLocked: [],
    };

    const scan = scanAppleNotesExport(exportResult);
    // Ticket 01KQFG3MEY8K9PZ8KSW7QH6BAF: no wrapper folder, no account
    // prefix, no intermediate path — each picked folder lands at root
    // under its LEAF name only ("Foo" not "iCloud/Projects/Foo").
    expect(scan.sourceRootName).toBeNull();

    const folderRels = scan.entries
      .filter((e) => e.kind === 'folder')
      .map((e) => e.relPath);
    expect(folderRels).toContain(''); // synthetic root entry
    expect(folderRels).toContain('Notes');
    expect(folderRels).toContain('Foo');
    expect(folderRels).toContain('Personal');
    // No iCloud / On My Mac wrappers, no Projects intermediate.
    expect(folderRels).not.toContain('iCloud');
    expect(folderRels).not.toContain('iCloud/Notes');
    expect(folderRels).not.toContain('iCloud/Projects');
    expect(folderRels).not.toContain('iCloud/Projects/Foo');
    expect(folderRels).not.toContain('On My Mac');
    expect(folderRels).not.toContain('On My Mac/Personal');

    // File entries — three notes, each mounted under its leaf folder.
    const fileEntries = scan.entries.filter((e) => e.kind === 'file');
    expect(fileEntries).toHaveLength(3);

    const helloEntry = fileEntries.find((e) => e.relPath.endsWith('Hello.md'));
    if (helloEntry?.kind !== 'file') throw new Error('expected file');
    expect(helloEntry.parentRelPath).toBe('Notes');

    // Body has H1 prepended (engine relies on this for title).
    expect(helloEntry.preReadBytes).toMatch(/^# Hello/);
  });

  it('handles empty export gracefully', () => {
    const scan = scanAppleNotesExport({ notes: [], skippedLocked: [] });
    expect(scan.entries.filter((e) => e.kind === 'file')).toHaveLength(0);
    // Still has the synthetic root folder entry.
    expect(scan.entries.some((e) => e.kind === 'folder' && e.relPath === '')).toBe(true);
  });

  it('strips slashes from note titles to avoid phantom subfolders', () => {
    const scan = scanAppleNotesExport({
      notes: [
        {
          accountName: 'iCloud',
          folderPath: 'Notes',
          name: 'Some/title/with/slashes',
          bodyHtml: '<p>x</p>',
          createdAt: 0,
          modifiedAt: 0,
          pinned: false,
        },
      ],
      skippedLocked: [],
    });
    const fileEntry = scan.entries.find((e) => e.kind === 'file');
    if (fileEntry?.kind !== 'file') throw new Error('expected file');
    // Title slashes replaced with spaces.
    expect(fileEntry.relPath).not.toContain('Some/title');
    expect(fileEntry.relPath).toContain('Some title with slashes');
  });
});

describe('extractInlineImages — base64 data URI handling', () => {
  // Tiny valid PNG (1x1 transparent pixel).
  const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

  it('extracts supported MIME types into images array, replaces with placeholder', () => {
    const html = `<p>Hello</p><img src="data:image/png;base64,${TINY_PNG_B64}" alt="x"><p>World</p>`;
    const r = extractInlineImages(html, 0);
    expect(r.images).toHaveLength(1);
    expect(r.images[0]!.mimeType).toBe('image/png');
    expect(r.images[0]!.bytes.length).toBeGreaterThan(0);
    expect(r.cleanedHtml).toContain('data-apple-notes-image:0');
    expect(r.cleanedHtml).not.toContain('base64,');
    expect(r.strippedCount).toBe(0);
  });

  it('strips unsupported MIME types (TIFF) and counts them', () => {
    const html = `<p>Anti French</p><img src="data:image/tiff;base64,TU0AKgB0...">`;
    const r = extractInlineImages(html, 0);
    expect(r.images).toHaveLength(0);
    expect(r.strippedCount).toBe(1);
    expect(r.cleanedHtml).not.toContain('base64,');
    expect(r.cleanedHtml).not.toContain('<img');
  });

  it('handles multiple images in one body with sequential placeholders', () => {
    const html = `<img src="data:image/png;base64,${TINY_PNG_B64}"><img src="data:image/jpeg;base64,${TINY_PNG_B64}">`;
    const r = extractInlineImages(html, 5);
    expect(r.images).toHaveLength(2);
    expect(r.images[0]!.placeholder).toBe('data-apple-notes-image:5');
    expect(r.images[1]!.placeholder).toBe('data-apple-notes-image:6');
  });

  it('passes through non-data img refs unchanged', () => {
    const html = `<img src="https://example.com/x.png"><img src="morion://attachment/abc">`;
    const r = extractInlineImages(html, 0);
    expect(r.images).toHaveLength(0);
    expect(r.strippedCount).toBe(0);
    expect(r.cleanedHtml).toContain('https://example.com/x.png');
    expect(r.cleanedHtml).toContain('morion://attachment/abc');
  });

  it('handles base64 with embedded whitespace/newlines (Apple Notes line-wrap)', () => {
    const wrapped = TINY_PNG_B64.replace(/(.{20})/g, '$1\n  ');
    const html = `<img src="data:image/png;base64,${wrapped}">`;
    const r = extractInlineImages(html, 0);
    expect(r.images).toHaveLength(1);
    // Decoded bytes should match the unwrapped version.
    expect(r.images[0]!.bytes.length).toBe(
      Buffer.from(TINY_PNG_B64, 'base64').length,
    );
  });
});

describe('scanAppleNotesExport — inline image extraction integration', () => {
  const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

  it('moves base64 images out of body into perFileImages, surfaces stripped count as warning', () => {
    const scan = scanAppleNotesExport({
      notes: [
        {
          accountName: 'iCloud',
          folderPath: 'Chess',
          name: 'Anti French',
          bodyHtml: `<p>Opening</p><img src="data:image/png;base64,${TINY_PNG_B64}"><img src="data:image/tiff;base64,TU0AKgB0FAKEDATA">`,
          createdAt: 1700000000000,
          modifiedAt: 1700000001000,
          pinned: false,
        },
      ],
      skippedLocked: [],
    });
    // Body should NOT carry base64 anymore.
    const fileEntry = scan.entries.find(
      (e) => e.kind === 'file' && e.relPath.endsWith('Anti French.md'),
    );
    if (fileEntry?.kind !== 'file') throw new Error('expected file');
    expect(fileEntry.preReadBytes).not.toContain('base64,');
    // Supported image lifted into perFileImages keyed by relPath.
    expect(scan.perFileImages).toBeDefined();
    const images = scan.perFileImages!.get(fileEntry.relPath);
    expect(images).toBeDefined();
    expect(images).toHaveLength(1);
    expect(images![0]!.mimeType).toBe('image/png');
    // Unsupported (TIFF) bumps a warning.
    const tiffWarn = scan.conversionWarnings.find((w) =>
      w.message.includes('stripped'),
    );
    expect(tiffWarn).toBeDefined();
  });
});

describe('ImportEngine.runFromAppleNotes — engine integration via scanner output', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('runs end-to-end through processScan path (uses scanner directly)', async () => {
    // We don't actually shell out to osascript here — the test calls
    // the engine via a public method that bypasses the AppleScript
    // probe. To keep the test hermetic on non-darwin CI runners, we
    // exercise scanAppleNotesExport + processScan together by calling
    // the engine's runFromUpload-style path with a synthesised
    // export result. Since runFromAppleNotes spawns osascript, we
    // can't use it directly in unit tests. Instead, we replicate
    // the same processScan flow with the scanner's output to verify
    // the integration shape.
    const scan = scanAppleNotesExport({
      notes: [
        {
          accountName: 'iCloud',
          folderPath: 'Notes',
          name: 'Hello World',
          bodyHtml: '<h1>Hello World</h1><p>Body content here.</p>',
          createdAt: 1700000000000,
          modifiedAt: 1700000001000,
          pinned: false,
        },
        {
          accountName: 'iCloud',
          folderPath: 'Projects',
          name: 'Project A',
          bodyHtml: '<p>Content for project A.</p>',
          createdAt: 1700000002000,
          modifiedAt: 1700000003000,
          pinned: true,
        },
      ],
      skippedLocked: [],
    });

    // Use the engine's internal processScan via the runFromUpload path
    // — same code path runFromAppleNotes uses internally.
    const engine = new ImportEngine(ctx.notes, ctx.folders, 'user');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary = await (engine as any).runProcessScan(
      scan,
      '/__test-no-root__',
    );

    expect(summary.imported).toBe(2);
    expect(summary.errored).toBe(0);
    // No wrapper folder — picked folders land directly at Morion's
    // root by leaf name only (no iCloud account parent).
    expect(summary.rootFolderId).toBeNull();
    expect(ctx.folders.getByName('iCloud', null)).toBeNull();

    const notesFolder = ctx.folders.getByName('Notes', null);
    const projectsFolder = ctx.folders.getByName('Projects', null);
    expect(notesFolder).not.toBeNull();
    expect(projectsFolder).not.toBeNull();

    const allNotes = ctx.notes.list({ limit: 100, offset: 0 });
    const hello = allNotes.find((n) => n.title === 'Hello World');
    expect(hello?.folderId).toBe(notesFolder!.id);
    const project = allNotes.find((n) => n.title === 'Project A');
    expect(project?.folderId).toBe(projectsFolder!.id);
  });
});
