import { z } from 'zod';

/**
 * A single attachment row. Binary data lives at `filePath` on disk — the DB
 * only carries metadata. Cascade on note delete wipes the row; the file is
 * unlinked by the route handler that triggered the purge (see
 * `src/server/routes/notes.ts` + `NotesRepository.purgeOlderThan` /
 * `purgeAllTrashed` / `purge` which collect `pathsForNotes(ids)` before the
 * rows go).
 *
 * The `Attachment` interface from `src/core/notes/types.ts` (since MVP) is
 * narrower and kept for docs/types read-only use; Phase 1 adds `createdAt`
 * and optional `width`/`height` here via migration 0008.
 */
export interface Attachment {
  id: string;
  noteId: string;
  filePath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
  width: number | null;
  height: number | null;
}

/**
 * MIME types the app actually accepts. SVG is excluded on purpose — it can
 * carry `<script>` and opening `/api/attachments/:id` in a new tab would
 * execute it under the `tauri://localhost` origin. If the Apple Notes
 * importer later needs SVG, it converts to PNG in the importer, not here.
 */
export const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
export type AllowedMime = (typeof ALLOWED_MIME_TYPES)[number];

/**
 * Per-file upload cap. 10 MB covers any retina screenshot + most phone photos
 * without special-casing. Server-side check is both on Content-Length (early
 * reject before reading the body) and on actual bytes after parsing (defence
 * against lying headers).
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Wire-format URL shape. `![alt](morion://attachment/<ulid>)` round-trips
 * through tiptap-markdown unchanged and is self-identifying in the body. */
export const MORION_ATTACHMENT_URL_PREFIX = 'morion://attachment/';

/** Stable ulid pattern used to validate `:id` path params. Matches
 * Crockford base32 (upper and lower case). */
export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * Zod schema for validating attachment IDs on `GET /api/attachments/:id`
 * and the MCP `notes_get_attachment` tool. Rejects path-traversal (`../`)
 * and any non-ulid shape before the repo is even touched.
 */
export const attachmentIdSchema = z.string().regex(ULID_REGEX);
