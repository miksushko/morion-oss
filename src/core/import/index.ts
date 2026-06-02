/**
 * Import from external sources — Phase 1 module.
 *
 * Public API:
 *   - `ImportEngine` — run a single import batch (file or folder).
 *   - `ImportRegistry` — enforce one-active-import + replay events for
 *     late SSE subscribers.
 *   - Format scanners (`scanMarkdownFile`, `scanMarkdownFolder`) — produce
 *     ordered `ImportEntry` lists; consumed by `ImportEngine`.
 *   - `FolderResolver` — internal, exposed for tests.
 *
 * The HTTP route + Tauri menu wire everything via `ImportEngine.run` →
 * `ImportRegistry.reserve` / `release`. SSE replays via
 * `registry.bufferedEvents(batchId)` + live forwarding from
 * `engine.events`.
 *
 * Phase 2 will add `formats/markdown.ts` extensions for frontmatter,
 * `sanitize.ts`, and `attachments.ts` (image-next-to-md). Phase 3 adds
 * `formats/apple-notes.ts`. Phase 4 adds `formats/docx.ts`. The
 * `ImportEngine` shape stays the same — formats just emit
 * `ImportEntry` items.
 */

export { ImportEngine } from './engine.js';
export { ImportRegistry } from './registry.js';
export { FolderResolver } from './folder-resolver.js';
export {
  scanMarkdownFile,
  scanMarkdownFolder,
  readMarkdownBody,
  deriveTitle,
} from './formats/markdown.js';
export {
  scanUploadedFile,
  scanUploadedFolder,
  type UploadedFile,
} from './formats/markdown-upload.js';
export {
  listAppleNotesFolders,
  runAppleNotesExport,
  scanAppleNotesExport,
  htmlToMarkdown,
  extractInlineImages,
  AppleNotesPermissionError,
  AppleNotesNotInstalledError,
  type AppleNotesFolder,
  type AppleNotesNote,
  type AppleNotesExportResult,
  type AppleNotesScanResult,
  type ExtractedAppleNotesImage,
  type ExtractInlineImagesResult,
} from './formats/apple-notes/index.js';
export type {
  ImportEntry,
  ImportEntryFile,
  ImportEntryFolder,
  ImportEvent,
  ImportSummary,
  ImportSource,
  ImportEngineOptions,
} from './types.js';
export type { RunMarkdownInput, RunMarkdownUploadInput } from './engine.js';
export type { ActiveImport } from './registry.js';
