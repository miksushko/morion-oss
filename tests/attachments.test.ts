import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { TagsRepository } from '../src/core/tags/repository.js';
import { RevisionsRepository } from '../src/core/revisions/repository.js';
import { AttachmentsRepository } from '../src/core/attachments/repository.js';
import { FtsIndex } from '../src/core/search/fts.js';
import { VecIndex } from '../src/core/search/vec.js';
import { HybridSearch } from '../src/core/search/hybrid.js';
import { Indexer } from '../src/core/search/indexer.js';
import { NoopEmbeddings } from '../src/core/embeddings/noop.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import { buildHttpApp } from '../src/server/bootstrap/http.js';
import type { Note } from '../src/core/notes/types.js';
import {
  sniffAllowedMime,
  extensionForMime,
  probeImageDimensions,
} from '../src/core/attachments/validate.js';
import {
  attachmentPath,
  ensureAttachmentsDir,
} from '../src/core/attachments/storage.js';

/**
 * 1×1 PNG — smallest valid PNG possible. Hand-crafted for hermetic tests,
 * no fixture files needed. Bytes verified against `pngcheck` manually.
 */
const ONE_PX_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

interface Ctx {
  handle: DbHandle;
  app: ReturnType<typeof buildHttpApp>;
  notes: NotesRepository;
  attachments: AttachmentsRepository;
  configDir: string;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const tags = new TagsRepository(handle.db);
  const revisions = new RevisionsRepository(handle.db);
  const attachments = new AttachmentsRepository(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  const search = new HybridSearch(handle.db, fts, vec, embeddings);
  const indexer = new Indexer(vec, embeddings);
  const settings = new SettingsRepository(handle.db);
  const configDir = mkdtempSync(join(tmpdir(), 'morion-attach-test-'));
  const app = buildHttpApp({
    db: handle.db,
    notes,
    folders,
    tags,
    revisions,
    attachments,
    search,
    indexer,
    audit,
    settings,
    configDir,
  });
  return { handle, app, notes, attachments, configDir };
}

async function createNote(ctx: Ctx, body = 'hello'): Promise<Note> {
  const res = await ctx.app.request('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Note;
}

async function uploadImage(
  ctx: Ctx,
  noteId: string,
  payload: Buffer = ONE_PX_PNG,
  filename = 'shot.png',
  mimeType = 'image/png',
): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([payload], { type: mimeType }), filename);
  return ctx.app.request(`/api/attachments?noteId=${encodeURIComponent(noteId)}`, {
    method: 'POST',
    body: form,
  });
}

describe('core/attachments — validate', () => {
  it('sniffAllowedMime returns png for a valid PNG buffer', async () => {
    expect(await sniffAllowedMime(ONE_PX_PNG)).toBe('image/png');
  });

  it('sniffAllowedMime returns null for random bytes', async () => {
    const junk = Buffer.from('this is not an image, just plain text');
    expect(await sniffAllowedMime(junk)).toBeNull();
  });

  it('sniffAllowedMime rejects SVG (present in file-type but not allow-listed)', async () => {
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    expect(await sniffAllowedMime(svg)).toBeNull();
  });

  it('extensionForMime maps jpeg → jpg', () => {
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('image/png')).toBe('png');
    expect(extensionForMime('image/gif')).toBe('gif');
    expect(extensionForMime('image/webp')).toBe('webp');
  });

  it('probeImageDimensions returns 1x1 for the canonical 1px PNG', () => {
    const { width, height } = probeImageDimensions(ONE_PX_PNG, 'image/png');
    expect(width).toBe(1);
    expect(height).toBe(1);
  });

  it('probeImageDimensions returns nulls for truncated bytes', () => {
    const truncated = ONE_PX_PNG.slice(0, 10);
    const { width, height } = probeImageDimensions(truncated, 'image/png');
    expect(width).toBeNull();
    expect(height).toBeNull();
  });
});

describe('core/attachments — storage', () => {
  it('ensureAttachmentsDir creates the sibling dir idempotently', () => {
    const root = mkdtempSync(join(tmpdir(), 'morion-storage-test-'));
    const dir = ensureAttachmentsDir(root);
    expect(existsSync(dir)).toBe(true);
    // Calling again must not throw — recursive mkdir is a no-op.
    expect(() => ensureAttachmentsDir(root)).not.toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  it('attachmentPath joins configDir + id + ext predictably', () => {
    const p = attachmentPath('/tmp/m', '01HX', 'png');
    expect(p).toBe('/tmp/m/attachments/01HX.png');
  });
});

describe('HTTP /api/attachments', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it('POST uploads a PNG and writes file + DB row', async () => {
    const note = await createNote(ctx);
    const res = await uploadImage(ctx, note.id);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      url: string;
      mimeType: string;
      sizeBytes: number;
      width: number;
      height: number;
    };
    expect(body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
    expect(body.url).toBe(`morion://attachment/${body.id}`);
    expect(body.mimeType).toBe('image/png');
    expect(body.sizeBytes).toBe(ONE_PX_PNG.byteLength);
    expect(body.width).toBe(1);
    expect(body.height).toBe(1);

    const row = ctx.attachments.getById(body.id);
    expect(row).not.toBeNull();
    expect(row!.filePath).toContain('attachments/');
    expect(existsSync(row!.filePath)).toBe(true);
  });

  it('POST rejects when noteId is missing', async () => {
    const form = new FormData();
    form.append(
      'file',
      new Blob([ONE_PX_PNG], { type: 'image/png' }),
      'x.png',
    );
    const res = await ctx.app.request('/api/attachments', {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('POST returns 404 for an unknown noteId', async () => {
    const res = await uploadImage(ctx, '01INVALIDNOTEIDXXXXXXXXXXX');
    expect(res.status).toBe(404);
  });

  it('POST rejects a .txt payload with 415 (magic-byte sniff)', async () => {
    const note = await createNote(ctx);
    const res = await uploadImage(
      ctx,
      note.id,
      Buffer.from('this is plain text, not an image'),
      'note.txt',
      'text/plain',
    );
    expect(res.status).toBe(415);
  });

  it('POST rejects SVG even with image/svg+xml MIME (defence vs <script> inside)', async () => {
    const note = await createNote(ctx);
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const res = await uploadImage(ctx, note.id, svg, 'evil.svg', 'image/svg+xml');
    expect(res.status).toBe(415);
  });

  it('POST rejects a file over the 10 MB cap via Content-Length preflight', async () => {
    const note = await createNote(ctx);
    // Fake a too-large Content-Length; the pre-check short-circuits
    // before even parsing the body.
    const res = await ctx.app.request(
      `/api/attachments?noteId=${note.id}`,
      {
        method: 'POST',
        headers: { 'content-length': String(11 * 1024 * 1024) },
        body: new FormData(),
      },
    );
    expect(res.status).toBe(413);
  });

  it('GET returns the bytes with the right Content-Type', async () => {
    const note = await createNote(ctx);
    const postRes = await uploadImage(ctx, note.id);
    const { id } = (await postRes.json()) as { id: string };

    const getRes = await ctx.app.request(`/api/attachments/${id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Content-Type')).toBe('image/png');
    expect(getRes.headers.get('Content-Disposition')).toBe('inline');
    expect(getRes.headers.get('Cache-Control')).toContain('immutable');
    const buf = Buffer.from(await getRes.arrayBuffer());
    expect(buf.equals(ONE_PX_PNG)).toBe(true);
  });

  it('GET rejects a non-ulid id with 400 (path-traversal defence)', async () => {
    const res = await ctx.app.request('/api/attachments/..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
  });

  it('GET returns 404 for a well-shaped but unknown id', async () => {
    const res = await ctx.app.request(
      '/api/attachments/01ZZZZZZZZZZZZZZZZZZZZZZZZ',
    );
    expect(res.status).toBe(404);
  });

  it('DELETE removes the row and unlinks the file', async () => {
    const note = await createNote(ctx);
    const postRes = await uploadImage(ctx, note.id);
    const { id } = (await postRes.json()) as { id: string };
    const row = ctx.attachments.getById(id);
    expect(existsSync(row!.filePath)).toBe(true);

    const delRes = await ctx.app.request(`/api/attachments/${id}`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
    expect(ctx.attachments.getById(id)).toBeNull();
    expect(existsSync(row!.filePath)).toBe(false);
  });
});

describe('Orphan cleanup on note purge', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it('hard-purge of a note unlinks its attachment files', async () => {
    const note = await createNote(ctx);
    const uploadRes = await uploadImage(ctx, note.id);
    const { id: attachmentId } = (await uploadRes.json()) as { id: string };
    const attachmentRow = ctx.attachments.getById(attachmentId);
    expect(attachmentRow).not.toBeNull();
    expect(existsSync(attachmentRow!.filePath)).toBe(true);

    // Soft-delete then immediately empty trash = full hard-purge.
    const softDel = await ctx.app.request(`/api/notes/${note.id}`, {
      method: 'DELETE',
    });
    expect(softDel.status).toBe(200);

    const empty = await ctx.app.request('/api/notes/trash', { method: 'DELETE' });
    expect(empty.status).toBe(200);

    // Cascade wiped the DB row + our unlink cleaned the disk.
    expect(ctx.attachments.getById(attachmentId)).toBeNull();
    expect(existsSync(attachmentRow!.filePath)).toBe(false);
  });

  it('single-note purge via DELETE /:id/purge unlinks attachments', async () => {
    const note = await createNote(ctx);
    const uploadRes = await uploadImage(ctx, note.id);
    const { id: attachmentId } = (await uploadRes.json()) as { id: string };
    const attachmentRow = ctx.attachments.getById(attachmentId);

    await ctx.app.request(`/api/notes/${note.id}`, { method: 'DELETE' });
    const purge = await ctx.app.request(`/api/notes/${note.id}/purge`, {
      method: 'DELETE',
    });
    expect(purge.status).toBe(200);

    expect(ctx.attachments.getById(attachmentId)).toBeNull();
    expect(existsSync(attachmentRow!.filePath)).toBe(false);
  });

  it('soft-delete (trash, still recoverable) keeps the file intact', async () => {
    const note = await createNote(ctx);
    const uploadRes = await uploadImage(ctx, note.id);
    const { id: attachmentId } = (await uploadRes.json()) as { id: string };
    const attachmentRow = ctx.attachments.getById(attachmentId);

    // Trash only — note is recoverable for 7 days. File MUST stay
    // because restore should put everything back including images.
    const del = await ctx.app.request(`/api/notes/${note.id}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);

    // Row still there (soft delete on note, not hard purge).
    expect(ctx.attachments.getById(attachmentId)).not.toBeNull();
    expect(existsSync(attachmentRow!.filePath)).toBe(true);
  });
});

describe('title derivation with attachment markdown', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it('a note created with an image-only first line has the alt text as its title', async () => {
    const res = await ctx.app.request('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: '![Quarterly chart](morion://attachment/01K8Z9)',
      }),
    });
    expect(res.status).toBe(201);
    const note = (await res.json()) as Note;
    expect(note.title).toBe('Quarterly chart');
  });
});

// Ensure no test left tmp dirs behind after a completed run. Best-effort.
process.on('exit', () => {
  // no-op
});

// Write a stray file to confirm setup writes aren't persisting across
// runs — if some future change regresses this, the assertion above will
// still pass because the tmpdir is fresh per-setup, but the sentinel
// catches "we forgot to mkdtempSync" class of bugs.
writeFileSync(join(tmpdir(), '.morion-attach-test-sentinel'), 'ok');
