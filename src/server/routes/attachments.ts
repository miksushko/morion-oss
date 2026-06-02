import type { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { ToolContext } from '../tools/types.js';
import {
  ALLOWED_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  MORION_ATTACHMENT_URL_PREFIX,
  attachmentIdSchema,
} from '../../core/attachments/types.js';
import {
  attachmentPartialPath,
  attachmentPath,
  ensureAttachmentsDir,
} from '../../core/attachments/storage.js';
import {
  extensionForMime,
  probeImageDimensions,
  sniffAllowedMime,
} from '../../core/attachments/validate.js';
import { canPerform } from '../../core/permissions/check.js';

/**
 * HTTP routes for inline image attachments (Direction P, Phase 1).
 *
 * Wire format: body stores `![alt](morion://attachment/<ulid>)`. The
 * frontend's custom Tiptap Image node resolves this scheme via an
 * auth'd blob fetch; external `https://` images are passed straight to
 * `<img src>` and never hit these endpoints.
 *
 * Three endpoints:
 *   - POST /api/attachments?noteId=<id> — multipart/form-data upload.
 *     Bounded at `MAX_ATTACHMENT_BYTES` (10 MB) via Content-Length
 *     pre-check + post-parse size verify.  Sniffs MIME from magic bytes
 *     (Content-Type header is advisory only), rejects SVG + non-image
 *     types.  Writes atomically: `<id>.<ext>.partial` then rename.
 *
 *   - GET  /api/attachments/:id — stream bytes from disk via
 *     fs.createReadStream. `immutable` cache header because ids are stable
 *     and content never gets rewritten under the same id.
 *
 *   - DELETE /api/attachments/:id — remove row + unlink file (manual
 *     cleanup for future "remove from note" UI; not called by Phase 1 but
 *     ships now since it's three lines given the repo helper).
 *
 * Cleanup of attachments on note hard-purge lives in `routes/notes.ts` —
 * the trash endpoints call `ctx.attachments.pathsForNotes(ids)` BEFORE
 * `purgeOlderThan` / `purgeAllTrashed` / `purge` so the cascade doesn't
 * wipe the row before we read `file_path`.
 *
 * Auth: every path goes through `registerAuthGate` like every other
 * `/api/*` route. Browser `<img src>` can't send custom headers, which
 * is why the frontend fetches the bytes as a Blob, creates an object
 * URL, and uses that in the node view (see
 * `src/web/src/editor/MorionImageNodeView.tsx`).
 */

const uploadQuerySchema = z.object({
  noteId: z.string().min(1),
});

export function registerAttachmentRoutes(app: Hono, ctx: ToolContext): void {
  app.post('/api/attachments', async (c) => {
    const { noteId } = uploadQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    // Verify the owner note exists and isn't trashed. `attachments.note_id`
    // has NOT NULL + FK REFERENCES notes(id), so a stale id would blow up
    // at insert time with an obscure constraint error — better to return
    // 404 up-front.
    const note = ctx.notes.getById(noteId);
    if (!note) return c.json({ error: 'note_not_found' }, 404);

    // Permission gate: uploading an attachment counts as mutating the
    // note's content. Free tier short-circuits to true; Pro respects
    // per-folder + per-note update gates.
    if (!canPerform('update', ctx, { kind: 'note', noteId })) {
      return c.json({ error: 'mcp_access_denied' }, 403);
    }

    // Early-reject via Content-Length so we don't buffer a 2 GB body
    // only to discover the cap. The header is client-supplied and
    // not trusted — we re-check the actual parsed size below.
    const contentLength = Number.parseInt(c.req.header('content-length') ?? '0', 10);
    if (contentLength > MAX_ATTACHMENT_BYTES) {
      return c.json(
        { error: 'attachment_too_large', limit: MAX_ATTACHMENT_BYTES },
        413,
      );
    }

    // hono's parseBody handles multipart/form-data; when the form has a
    // single `file` field, we get a Web `File`. For the 10 MB cap it's
    // fine to read into memory — streaming multipart parsers (busboy)
    // would rewrite the endpoint from scratch and the cap stays low.
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      return c.json({ error: 'invalid_multipart' }, 400);
    }
    const raw = form.file;
    if (!(raw instanceof File)) {
      return c.json({ error: 'file_field_required' }, 400);
    }
    if (raw.size > MAX_ATTACHMENT_BYTES) {
      return c.json(
        { error: 'attachment_too_large', limit: MAX_ATTACHMENT_BYTES },
        413,
      );
    }
    const buffer = Buffer.from(await raw.arrayBuffer());

    // Sniff + allow-list. SVG + non-image types land here as null.
    const mime = await sniffAllowedMime(buffer);
    if (!mime) {
      return c.json(
        { error: 'unsupported_media_type', allowed: ALLOWED_MIME_TYPES },
        415,
      );
    }

    const id = ulid();
    const ext = extensionForMime(mime);
    ensureAttachmentsDir(ctx.configDir);
    const tmpPath = attachmentPartialPath(ctx.configDir, id, ext);
    const finalPath = attachmentPath(ctx.configDir, id, ext);

    // Write tmp → rename. If the process dies mid-write, `.partial`
    // is the leftover and can be garbage-collected by a future
    // startup scan. `writeFileSync` is atomic-at-the-file-level in
    // better-sqlite3's single-process model.
    writeFileSync(tmpPath, buffer);

    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const { width, height } = probeImageDimensions(buffer, mime);

    try {
      await rename(tmpPath, finalPath);
    } catch (err) {
      // Rename should basically never fail on same-fs; log and bail.
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort
      }
      return c.json(
        { error: 'storage_failure', detail: (err as Error).message },
        500,
      );
    }

    const row = ctx.attachments.create({
      noteId,
      filePath: finalPath,
      mimeType: mime,
      sizeBytes: buffer.byteLength,
      sha256,
      width,
      height,
    });

    return c.json(
      {
        id: row.id,
        url: `${MORION_ATTACHMENT_URL_PREFIX}${row.id}`,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        width: row.width,
        height: row.height,
      },
      201,
    );
  });

  app.get('/api/attachments/:id', (c) => {
    const parsed = attachmentIdSchema.safeParse(c.req.param('id'));
    if (!parsed.success) return c.json({ error: 'invalid_id' }, 400);

    const row = ctx.attachments.getById(parsed.data);
    if (!row) return c.json({ error: 'not_found' }, 404);

    // Permission gate: read maps 1:1 to the owning note's read permission.
    if (!canPerform('read', ctx, { kind: 'note', noteId: row.noteId })) {
      return c.json({ error: 'mcp_access_denied' }, 403);
    }

    if (!existsSync(row.filePath)) {
      // Row exists but file doesn't — probably a stale DB after an
      // aborted migration or a manual `rm` in the attachments dir.
      // Treat as 404 for the caller; a background reaper could prune
      // the orphan row later.
      return c.json({ error: 'file_missing' }, 404);
    }

    // fs.createReadStream returns a Node Readable. hono's `c.body`
    // accepts a Web ReadableStream — convert via Node's fromWeb/toWeb
    // bridge. The file handle is closed when the stream ends.
    const nodeStream = createReadStream(row.filePath);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    c.header('Content-Type', row.mimeType);
    c.header('Content-Length', String(row.sizeBytes));
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    c.header('Content-Disposition', 'inline');
    return c.body(webStream);
  });

  app.delete('/api/attachments/:id', (c) => {
    const parsed = attachmentIdSchema.safeParse(c.req.param('id'));
    if (!parsed.success) return c.json({ error: 'invalid_id' }, 400);

    const row = ctx.attachments.getById(parsed.data);
    if (!row) return c.json({ error: 'not_found' }, 404);

    // Deleting an attachment is a content edit of the owning note —
    // gate the same way.
    if (!canPerform('update', ctx, { kind: 'note', noteId: row.noteId })) {
      return c.json({ error: 'mcp_access_denied' }, 403);
    }

    const filePath = ctx.attachments.deleteById(parsed.data);
    if (filePath) {
      try {
        if (existsSync(filePath)) {
          const stat = statSync(filePath);
          if (stat.isFile()) unlinkSync(filePath);
        }
      } catch (err) {
        console.warn(
          `[attachments] unlink failed for ${filePath}: ${(err as Error).message}`,
        );
      }
    }
    return c.json({ ok: true });
  });
}
