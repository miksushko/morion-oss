import { api, type Note } from './api';
import { sanitizeFilename } from './exportNote';

/**
 * Export every live note in a folder as a `.zip` of `.md` files.
 *
 * Mirrors the single-note `Export to .md` flow — same `<a download>`
 * mechanism, same lossless markdown body, same browser-only path that
 * works in dev + every Tauri webview without a Rust IPC.
 *
 * The user's OS save dialog handles the picker (browsers prompt the
 * default Downloads folder; "Always ask before downloading" enables a
 * full Save-As). The download is a single `.zip` so the operation is
 * atomic — no half-written tree on disk to clean up if the network
 * blips or the user cancels.
 *
 * Filtering: archived notes are excluded (matches "user has hidden it"
 * semantic); soft-deleted notes are excluded; `mo:*` system notes are
 * already filtered server-side. The export is what the user actually
 * sees in the folder.
 *
 * Body shape: note body verbatim. If the note has tags, append a blank
 * line + bare comma-separated list at the very end (per the ticket
 * spec — "под основным контентом, добавляем тэги перечислением через
 * запятую"). No frontmatter, no labels — re-import treats it as plain
 * body text, which matches what the user sees on screen today.
 */
export async function exportFolderAsMarkdownZip(
  folderId: string,
  folderName: string,
): Promise<{ fileCount: number }> {
  // The /api/notes route caps `limit` at 5000 (server-side validation).
  // Page through with offset for the rare folder over that bound; most
  // folders fit in one request.
  const PAGE = 5000;
  const all: Note[] = [];
  let offset = 0;
  let total = 0;
  while (true) {
    const page = await api.listNotes({ folderId, limit: PAGE, offset });
    all.push(...page.notes);
    total = page.total;
    if (page.notes.length < PAGE || all.length >= total) break;
    offset += page.notes.length;
    // Defence against a server total/page-size desync that would
    // otherwise infinite-loop a misconfigured environment.
    if (offset > 100_000) break;
  }
  const files = buildMarkdownFiles(all);
  const zip = buildStoreZip(files);
  triggerZipDownload(zip, sanitizeFilename(folderName) + '.zip');
  return { fileCount: files.length };
}

interface ZipEntry {
  /** Filename inside the zip (UTF-8). No directory prefix — flat layout. */
  name: string;
  /** UTF-8 bytes of the .md file contents. */
  data: Uint8Array;
}

/**
 * Format every note into a `(name, bytes)` pair, deduping filenames so
 * two notes with the same title don't collide inside the zip. Skips
 * the rare case where `listNotes` somehow returned a soft-deleted /
 * archived note (the API filters them, but we re-check defensively so
 * a future API regression doesn't leak archived bodies into exports).
 */
export function buildMarkdownFiles(notes: Note[]): ZipEntry[] {
  const enc = new TextEncoder();
  const used = new Set<string>();
  const out: ZipEntry[] = [];
  for (const note of notes) {
    if (note.deletedAt != null || note.archivedAt != null) continue;
    const body = formatNoteBody(note);
    const baseName = sanitizeFilename(note.title || 'untitled');
    const fileName = uniqueFilename(baseName, used);
    used.add(fileName);
    out.push({ name: fileName, data: enc.encode(body) });
  }
  return out;
}

/**
 * Assemble the file body per the ticket spec: markdown body verbatim,
 * then a blank line + bare comma-separated tag list IF the note has
 * tags. No frontmatter, no "Tags:" label — matches the user's spec
 * verbatim ("в конце файла, под основным контентом, добавляем тэги
 * перечислением через запятую"). Stable trailing newline so concat
 * with `\n` later is well-defined.
 */
export function formatNoteBody(note: Pick<Note, 'body' | 'tags'>): string {
  const body = note.body ?? '';
  const tagLine = note.tags && note.tags.length > 0 ? note.tags.join(', ') : '';
  if (!tagLine) return body;
  // Ensure exactly one blank line separates body from tag line, even
  // if the body already ends with newlines.
  const trimmed = body.replace(/\s+$/, '');
  return trimmed + '\n\n' + tagLine + '\n';
}

/**
 * Resolve a base filename + `.md` suffix; if it would collide with a
 * name already in the zip, suffix with ` (2)` / ` (3)` / etc. until
 * unique. Same shape as the import path's duplicate handling.
 */
export function uniqueFilename(base: string, used: Set<string>): string {
  const candidate = base + '.md';
  if (!used.has(candidate)) return candidate;
  for (let n = 2; n < 10_000; n++) {
    const tagged = `${base} (${n}).md`;
    if (!used.has(tagged)) return tagged;
  }
  // Ten-thousand collisions on the same title is implausible; fall
  // back to a timestamp suffix so we still produce a unique name.
  return `${base} (${Date.now()}).md`;
}

/**
 * Hand-rolled STORE-method (uncompressed) ZIP writer. Pure JS, no
 * deps — we don't need DEFLATE since markdown bodies are already
 * small + browsers can handle uncompressed archives identically to
 * compressed ones. Spec: PKWARE APPNOTE 6.3.10, sections 4.3.6
 * (local file header), 4.3.12 (central dir header), 4.3.16 (end of
 * central directory record).
 *
 * The `mtime` parameter exists so tests can pin DOS-time bytes for
 * deterministic byte-level assertions; production calls leave it
 * undefined and get `new Date()`.
 */
export function buildStoreZip(
  entries: ZipEntry[],
  mtime: Date = new Date(),
): Uint8Array {
  const enc = new TextEncoder();
  const dosTime = encodeDosTime(mtime);
  const dosDate = encodeDosDate(mtime);

  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    // Local file header (30 bytes + name + data).
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 filename (bit 11)
    lv.setUint16(8, 0, true); // method: STORE
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size = size for STORE
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    localHeader.set(nameBytes, 30);

    localChunks.push(localHeader, entry.data);

    // Central directory header (46 bytes + name).
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, localOffset, true);
    centralHeader.set(nameBytes, 46);

    centralChunks.push(centralHeader);

    localOffset += localHeader.length + entry.data.length;
  }

  const centralSize = centralChunks.reduce((n, c) => n + c.length, 0);
  const centralOffset = localOffset;

  // End of central directory record (22 bytes, no comment).
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // disk with CD
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true); // comment length

  const total =
    localOffset +
    centralSize +
    eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of localChunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  for (const chunk of centralChunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  out.set(eocd, pos);
  return out;
}

function encodeDosTime(d: Date): number {
  // Two-second precision per the spec; floor seconds.
  const h = d.getHours();
  const m = d.getMinutes();
  const s = Math.floor(d.getSeconds() / 2);
  return ((h & 0x1f) << 11) | ((m & 0x3f) << 5) | (s & 0x1f);
}

function encodeDosDate(d: Date): number {
  // DOS year is offset from 1980; clamp anything before since the
  // format can't represent it.
  const y = Math.max(1980, d.getFullYear()) - 1980;
  const mo = d.getMonth() + 1; // 1..12
  const day = d.getDate(); // 1..31
  return ((y & 0x7f) << 9) | ((mo & 0xf) << 5) | (day & 0x1f);
}

let crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** IEEE 802.3 CRC-32, the same polynomial ZIP and gzip use. */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (c >>> 8) ^ table[(c ^ bytes[i]) & 0xff];
  }
  return (c ^ 0xffffffff) >>> 0;
}

function triggerZipDownload(zip: Uint8Array, filename: string): void {
  // Construct the Blob from a fresh ArrayBuffer slice — passing a
  // typed-array view directly works too, but slicing keeps the Blob
  // payload independent of any future buffer reuse.
  const ab = zip.buffer.slice(
    zip.byteOffset,
    zip.byteOffset + zip.byteLength,
  ) as ArrayBuffer;
  const blob = new Blob([ab], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }
}
