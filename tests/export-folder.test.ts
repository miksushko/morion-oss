import { describe, it, expect } from 'vitest';
import {
  buildMarkdownFiles,
  buildStoreZip,
  crc32,
  formatNoteBody,
  uniqueFilename,
} from '../src/web/src/lib/exportFolder';
import type { Note } from '../src/web/src/lib/api';

function fakeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: '01TEST00000000000000000000',
    folderId: '01FOLDER000000000000000000',
    title: 'Test',
    body: 'hello world',
    pinned: false,
    source: 'user',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    archivedAt: null,
    status: 'note',
    position: null,
    tags: [],
    mcpPermissions: { visible: null, update: null, delete: null },
    ...overrides,
  };
}

describe('crc32', () => {
  // Known IEEE CRC-32 vectors (polynomial 0xEDB88320). Locks in our
  // table init + initial value + final inversion against a portable
  // reference. Off-by-one bugs in any of the three hop these tests.
  const enc = new TextEncoder();
  it('empty input → 0x00000000', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
  it('"123456789" → 0xCBF43926', () => {
    expect(crc32(enc.encode('123456789')).toString(16)).toBe('cbf43926');
  });
  it('"abc" → 0x352441C2', () => {
    expect(crc32(enc.encode('abc')).toString(16)).toBe('352441c2');
  });
});

describe('formatNoteBody', () => {
  it('returns body verbatim when no tags', () => {
    expect(formatNoteBody({ body: 'plain text', tags: [] })).toBe('plain text');
  });
  it('appends bare comma-separated tag list under the body', () => {
    expect(formatNoteBody({ body: 'note body', tags: ['a', 'b', 'c'] })).toBe(
      'note body\n\na, b, c\n',
    );
  });
  it('normalises trailing whitespace before appending tags', () => {
    expect(formatNoteBody({ body: 'note body\n\n\n', tags: ['x'] })).toBe(
      'note body\n\nx\n',
    );
  });
  it('handles empty body with tags', () => {
    expect(formatNoteBody({ body: '', tags: ['only-tag'] })).toBe(
      '\n\nonly-tag\n',
    );
  });
});

describe('uniqueFilename', () => {
  it('returns base + .md when no collision', () => {
    expect(uniqueFilename('foo', new Set())).toBe('foo.md');
  });
  it('suffixes (2) on first collision', () => {
    const used = new Set(['foo.md']);
    expect(uniqueFilename('foo', used)).toBe('foo (2).md');
  });
  it('escalates to (3), (4)... on continued collisions', () => {
    const used = new Set(['foo.md', 'foo (2).md']);
    expect(uniqueFilename('foo', used)).toBe('foo (3).md');
  });
});

describe('buildMarkdownFiles', () => {
  it('formats title → filename, body+tags → file bytes', () => {
    const files = buildMarkdownFiles([
      fakeNote({ title: 'My Note', body: 'body', tags: ['t1'] }),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('My Note.md');
    expect(new TextDecoder().decode(files[0].data)).toBe('body\n\nt1\n');
  });
  it('dedupes colliding titles', () => {
    const files = buildMarkdownFiles([
      fakeNote({ id: '1', title: 'Same' }),
      fakeNote({ id: '2', title: 'Same' }),
      fakeNote({ id: '3', title: 'Same' }),
    ]);
    expect(files.map((f) => f.name)).toEqual([
      'Same.md',
      'Same (2).md',
      'Same (3).md',
    ]);
  });
  it('sanitises filesystem-reserved chars in titles', () => {
    const files = buildMarkdownFiles([
      fakeNote({ title: 'foo/bar:baz' }),
    ]);
    expect(files[0].name).toBe('foo bar baz.md');
  });
  it('falls back to "untitled" for empty titles', () => {
    const files = buildMarkdownFiles([fakeNote({ title: '' })]);
    expect(files[0].name).toBe('untitled.md');
  });
  it('skips archived notes (defence-in-depth even though API filters)', () => {
    const files = buildMarkdownFiles([
      fakeNote({ id: '1', title: 'live' }),
      fakeNote({ id: '2', title: 'archived', archivedAt: 1 }),
    ]);
    expect(files.map((f) => f.name)).toEqual(['live.md']);
  });
  it('skips soft-deleted notes', () => {
    const files = buildMarkdownFiles([
      fakeNote({ id: '1', title: 'live' }),
      fakeNote({ id: '2', title: 'trashed', deletedAt: 1 }),
    ]);
    expect(files.map((f) => f.name)).toEqual(['live.md']);
  });
});

describe('buildStoreZip', () => {
  const enc = new TextEncoder();
  // Pinned mtime so DOS-time bytes are deterministic across CI clocks.
  const FIXED = new Date('2026-05-04T12:34:56Z');

  function readU32LE(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(
      0,
      true,
    );
  }
  function readU16LE(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(
      0,
      true,
    );
  }

  it('produces a valid zip envelope for one entry', () => {
    const data = enc.encode('hello');
    const zip = buildStoreZip([{ name: 'a.md', data }], FIXED);

    // Local file header signature at offset 0.
    expect(readU32LE(zip, 0)).toBe(0x04034b50);

    // CRC + size in local header.
    expect(readU32LE(zip, 14)).toBe(crc32(data));
    expect(readU32LE(zip, 18)).toBe(data.length);
    expect(readU32LE(zip, 22)).toBe(data.length);

    // End-of-central-directory at the very end (22-byte trailer).
    const eocd = zip.length - 22;
    expect(readU32LE(zip, eocd)).toBe(0x06054b50);
    expect(readU16LE(zip, eocd + 8)).toBe(1); // n entries on this disk
    expect(readU16LE(zip, eocd + 10)).toBe(1); // n entries total

    // Central directory pointed to by EOCD has the right signature.
    const cdOffset = readU32LE(zip, eocd + 16);
    expect(readU32LE(zip, cdOffset)).toBe(0x02014b50);
  });

  it('produces a valid zip envelope for multiple entries with correct counts', () => {
    const zip = buildStoreZip(
      [
        { name: 'a.md', data: enc.encode('one') },
        { name: 'b.md', data: enc.encode('two') },
        { name: 'c.md', data: enc.encode('three') },
      ],
      FIXED,
    );
    const eocd = zip.length - 22;
    expect(readU16LE(zip, eocd + 8)).toBe(3);
    expect(readU16LE(zip, eocd + 10)).toBe(3);
  });

  it('produces a valid (empty) zip envelope for zero entries', () => {
    const zip = buildStoreZip([], FIXED);
    expect(zip.length).toBe(22); // EOCD only
    expect(readU32LE(zip, 0)).toBe(0x06054b50);
    expect(readU16LE(zip, 8)).toBe(0);
    expect(readU16LE(zip, 10)).toBe(0);
  });

  it('marks the UTF-8 filename flag (bit 11) so non-ASCII names decode correctly', () => {
    const zip = buildStoreZip(
      [{ name: 'привет.md', data: enc.encode('hi') }],
      FIXED,
    );
    // Local file header flags at offset 6.
    expect(readU16LE(zip, 6) & 0x0800).toBe(0x0800);
  });
});
