/**
 * Post-import attachment stitching for upload-format scanners
 * (.docx + Apple Notes HTML) that produce inline image bytes during
 * parsing. Extracted from `../engine.ts` so the engine shell stays
 * focused on lifecycle.
 *
 * Both formats share the same flow: scan returns a per-file map of
 * `{placeholder, mimeType, bytes}`; after notes are created we find
 * each owning note by scanning bodies for the placeholder URL, write
 * the bytes to the attachment store, create SQL attachment rows, and
 * rewrite placeholders to `morion://attachment/<id>` refs.
 */

import type { AttachmentsRepository } from '../../attachments/repository.js';
import type { NotesRepository } from '../../notes/repository.js';
import { escapeRegex } from './helpers.js';

export interface FinaliseUploadImagesArgs {
  perFileImages: Map<
    string,
    Array<{ placeholder: string; mimeType: string; bytes: Buffer }>
  >;
  notes: NotesRepository;
  attachments: AttachmentsRepository;
  configDir: string;
  actor: string;
}

/**
 * Write extracted images to the attachment store + create SQL rows +
 * rewrite their placeholder srcs in the corresponding notes' bodies.
 * No-op when attachments repo / configDir are missing.
 */
export async function finaliseUploadImages(
  args: FinaliseUploadImagesArgs,
): Promise<void> {
  const { perFileImages, notes, attachments, configDir, actor } = args;
  // Lazy-import storage helpers — avoid circular module dep.
  const { ensureAttachmentsDir, attachmentPath } = await import(
    '../../attachments/storage.js'
  );
  const { extensionForMime, sniffAllowedMime } = await import(
    '../../attachments/validate.js'
  );
  const { ulid } = await import('ulid');
  const { writeFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');

  for (const [, images] of perFileImages) {
    // Find the note id created for this source file by scanning
    // the engine's audit / notes write history. Simpler: we
    // recorded `sourceFile` in audit meta — but we don't have
    // that hookup here. Use list+filter on notes by source +
    // recent timestamp + body containing the placeholder URL.
    // For typical uploads (1-50 docx) this is O(N²) and fine.
    const candidates = notes.list({ limit: 200, offset: 0 });
    const noteForFile = candidates.find((n) =>
      images.some((img) => n.body.includes(img.placeholder)),
    );
    if (!noteForFile) continue;

    let body = noteForFile.body;
    ensureAttachmentsDir(configDir);
    for (const img of images) {
      // MIME sniff to allowlist; reject SVG / unsupported.
      const sniffed = await sniffAllowedMime(img.bytes);
      if (!sniffed) {
        // Replace placeholder with a "removed" marker so the user
        // sees something meaningful rather than a dead URL.
        body = body.replace(
          new RegExp(escapeRegex(img.placeholder), 'g'),
          '[image: unsupported format]',
        );
        continue;
      }
      const id = ulid();
      const ext = extensionForMime(sniffed);
      const finalPath = attachmentPath(configDir, id, ext);
      writeFileSync(finalPath, img.bytes);
      const sha256 = createHash('sha256').update(img.bytes).digest('hex');
      attachments.createWithId({
        id,
        noteId: noteForFile.id,
        filePath: finalPath,
        mimeType: sniffed,
        sizeBytes: img.bytes.byteLength,
        sha256,
      });
      body = body.replace(
        new RegExp(escapeRegex(img.placeholder), 'g'),
        `morion://attachment/${id}`,
      );
    }
    notes.update(noteForFile.id, { body }, actor);
  }
}
