import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { writeFileSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { ulid } from 'ulid';
import type { AttachmentsRepository } from '../attachments/repository.js';
import {
  attachmentPartialPath,
  attachmentPath,
  ensureAttachmentsDir,
} from '../attachments/storage.js';
import {
  extensionForMime,
  probeImageDimensions,
  sniffAllowedMime,
} from '../attachments/validate.js';
import { MORION_ATTACHMENT_URL_PREFIX } from '../attachments/types.js';

/**
 * Inline-image attachment importer.
 *
 * Scans a markdown body for `![alt](src)` references, resolves each
 * to a path on disk relative to the source `.md` file, copies the
 * bytes into Morion's attachment store via the repo, and rewrites
 * the body to use `morion://attachment/<id>` URLs.
 *
 * Path resolution rules (per Phase 2 ticket):
 *
 *   - `image.png` → look in same dir as the `.md` file
 *   - `./assets/foo.png` → resolve relative to `.md` dir
 *   - `../shared/foo.png` → resolve relative to `.md` dir, must stay
 *     inside `importRoot` or skip with warning (path-traversal guard)
 *   - `/Users/abs/path.png` → absolute path; must be inside
 *     `importRoot` or skip with warning
 *   - `https://...` / `http://...` → leave as-is, don't download
 *   - `morion://attachment/<id>` → already-imported ref from another
 *     Morion install; leave as-is + warn (likely broken in this DB)
 *
 * Size cap: 10 MB per image. MIME allowlist via `sniffAllowedMime`
 * (PNG / JPEG / GIF / WebP). SVG explicitly rejected — can carry
 * script payloads. Caller logs skipped images via the `warnings`
 * array on the result.
 *
 * The owning note id is set AFTER the engine creates the note, so
 * the import flow is two-phase:
 *
 *   1. Scan body, allocate attachment files on disk, return rewritten
 *      body + array of pending attachment metadata (no note id yet).
 *   2. After `notes.create` returns the new id, finalise the
 *      attachment rows via `finaliseAttachments(noteId, pending)`.
 *
 * This split is necessary because attachments.create requires a
 * non-null `noteId` (FK), and we don't have that until after the
 * note insert. Files on disk land in their final location during
 * step 1; only the SQL row insert happens in step 2.
 */

const SIZE_CAP_BYTES = 10 * 1024 * 1024; // 10 MB
const IMAGE_REF_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

export interface PendingAttachment {
  /** Absolute path on disk where bytes have already been copied. */
  finalPath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  /** Pre-allocated attachment id — used in the morion:// URL even
   *  before the SQL row is created. */
  attachmentId: string;
}

export interface ProcessAttachmentsInput {
  body: string;
  /** Absolute path of the source `.md` file — used to resolve relative refs. */
  sourceMdPath: string;
  /** Absolute root the user is importing from (vault root or single-
   *  file's parent dir). Path-traversal guard: refs that resolve
   *  outside this root are skipped. */
  importRoot: string;
  /** Morion config dir — attachments live at
   *  `<configDir>/attachments/<id>.<ext>`. */
  configDir: string;
}

export interface ProcessAttachmentsResult {
  /** Body with image refs rewritten to `morion://attachment/<id>` URLs. */
  body: string;
  /** Attachments with bytes already on disk; need note id + SQL row. */
  pending: PendingAttachment[];
  /** Per-image skip reasons for the engine to surface in the batch
   *  summary. Each `warnings[i].file` is the original ref (relative
   *  or absolute) so the user can locate it. */
  warnings: Array<{ file: string; message: string }>;
}

/**
 * Phase 1: scan body, copy image bytes to attachments dir, rewrite
 * markdown refs. Skips and warns on:
 *   - http(s)://  → not downloaded (left as-is in body)
 *   - morion://   → kept (warning emitted; ref likely broken in this DB)
 *   - missing files
 *   - >10 MB
 *   - non-image / non-allowlist MIME
 *   - traversal outside importRoot
 */
export async function processInlineAttachments(
  input: ProcessAttachmentsInput,
): Promise<ProcessAttachmentsResult> {
  const warnings: Array<{ file: string; message: string }> = [];
  const pending: PendingAttachment[] = [];
  const sourceDir = dirname(input.sourceMdPath);
  const importRoot = resolvePath(input.importRoot);

  // Replace iteratively. Build a map of (originalRef → newRef|null).
  // null means the ref stays as-is.
  const replacements = new Map<string, string | null>();
  const matches = [...input.body.matchAll(IMAGE_REF_RE)];

  for (const match of matches) {
    const ref = match[2]?.trim() ?? '';
    if (replacements.has(ref)) continue;

    // Already-resolved Morion attachment URL — leave alone, warn.
    if (ref.startsWith('morion://attachment/')) {
      warnings.push({
        file: ref,
        message:
          'Reference is a morion:// URL from a different Morion install; ' +
          'attachment likely missing here. Re-attach manually.',
      });
      replacements.set(ref, null);
      continue;
    }

    // External URL — leave alone, no warning (this is normal markdown).
    if (/^https?:\/\//i.test(ref)) {
      replacements.set(ref, null);
      continue;
    }

    // Resolve to absolute path.
    const resolved = isAbsolute(ref)
      ? resolvePath(ref)
      : resolvePath(sourceDir, ref);

    // Path-traversal guard: must be inside importRoot.
    if (!isInsideRoot(resolved, importRoot)) {
      warnings.push({
        file: ref,
        message: `Image is outside the import root (${importRoot}); skipped.`,
      });
      replacements.set(ref, null);
      continue;
    }

    // Stat — must exist + be a file.
    let bytes: Buffer;
    try {
      const stat = statSync(resolved);
      if (!stat.isFile()) {
        warnings.push({ file: ref, message: 'Not a regular file; skipped.' });
        replacements.set(ref, null);
        continue;
      }
      if (stat.size > SIZE_CAP_BYTES) {
        warnings.push({
          file: ref,
          message: `Image larger than ${SIZE_CAP_BYTES / 1024 / 1024} MB; skipped.`,
        });
        replacements.set(ref, null);
        continue;
      }
      bytes = readFileSync(resolved);
    } catch (err) {
      warnings.push({
        file: ref,
        message: `Failed to read: ${(err as Error).message}`,
      });
      replacements.set(ref, null);
      continue;
    }

    // MIME sniff — allowlist (PNG / JPEG / GIF / WebP).
    const mime = await sniffAllowedMime(bytes);
    if (!mime) {
      warnings.push({
        file: ref,
        message:
          'Unsupported image format. Allowed: PNG, JPEG, GIF, WebP. ' +
          '(SVG is rejected because it can carry script payloads.)',
      });
      replacements.set(ref, null);
      continue;
    }

    const id = ulid();
    const ext = extensionForMime(mime);
    ensureAttachmentsDir(input.configDir);
    const tmpPath = attachmentPartialPath(input.configDir, id, ext);
    const finalPath = attachmentPath(input.configDir, id, ext);

    try {
      writeFileSync(tmpPath, bytes);
      await rename(tmpPath, finalPath);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort
      }
      warnings.push({
        file: ref,
        message: `Failed to copy bytes: ${(err as Error).message}`,
      });
      replacements.set(ref, null);
      continue;
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { width, height } = probeImageDimensions(bytes, mime);

    pending.push({
      finalPath,
      mimeType: mime,
      sizeBytes: bytes.byteLength,
      sha256,
      width,
      height,
      attachmentId: id,
    });

    replacements.set(ref, `${MORION_ATTACHMENT_URL_PREFIX}${id}`);
  }

  // Apply replacements. Walk the body once, replacing only at the
  // exact `(ref)` positions to avoid partial matches if a ref string
  // happens to appear in body prose.
  let outBody = input.body;
  if (replacements.size > 0) {
    outBody = input.body.replace(IMAGE_REF_RE, (match, alt: string, ref: string) => {
      const trimmed = ref.trim();
      const replacement = replacements.get(trimmed);
      if (replacement === undefined || replacement === null) return match;
      return `![${alt}](${replacement})`;
    });
  }

  return { body: outBody, pending, warnings };
}

/**
 * Phase 2: now that we have the new note id, insert SQL rows for each
 * pending attachment. Files are already on disk from `processInlineAttachments`.
 */
export function finaliseAttachments(
  noteId: string,
  pending: PendingAttachment[],
  attachments: AttachmentsRepository,
): void {
  for (const p of pending) {
    // Note: attachments.create allocates a fresh id. Our pre-allocated
    // attachmentId is what we used in the body URL. We need them to
    // match — so we insert via raw SQL with our id, not via .create().
    // Cheaper option: extend the repo with a `createWithId` method.
    // For now we use the raw insert via the repo's underlying handle.
    attachments.createWithId({
      id: p.attachmentId,
      noteId,
      filePath: p.finalPath,
      mimeType: p.mimeType,
      sizeBytes: p.sizeBytes,
      sha256: p.sha256,
      width: p.width,
      height: p.height,
    });
  }
}

function isInsideRoot(absPath: string, importRoot: string): boolean {
  // Normalise both, then check `absPath` starts with `importRoot/`
  // OR equals `importRoot`. Trailing-slash awareness so `importRoot`
  // = `/Users/me/V` doesn't accidentally accept `/Users/me/Vault2/x`.
  const normPath = resolvePath(absPath);
  const normRoot = resolvePath(importRoot);
  if (normPath === normRoot) return true;
  return normPath.startsWith(normRoot + '/') || normPath.startsWith(normRoot + '\\');
}

/** Test-only re-export. */
export const __test = { isInsideRoot, IMAGE_REF_RE, SIZE_CAP_BYTES };
