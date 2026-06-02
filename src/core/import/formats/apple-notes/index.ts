/**
 * Apple Notes import via AppleScript bridge.
 *
 * Two-phase flow:
 *
 *   1. `listAppleNotesFolders()` — quick probe via `osascript`. Returns
 *      every folder across every account with a note count. UI shows
 *      this list as a checkbox tree; user picks which folders to
 *      import. Cheap (~200-500ms for typical libraries).
 *
 *   2. `runAppleNotesExport({selectedFolders})` — full body+metadata
 *      pull for the picked folders. Each note's HTML body is converted
 *      to markdown via turndown. Streaming JSON-lines output keeps
 *      memory bounded for large libraries.
 *
 * macOS-only. Callers must guard with `process.platform === 'darwin'`
 * before invoking — non-macOS hosts have no `osascript` and the
 * AppleScript runtime in general.
 *
 * Permissions: first AppleScript invocation triggers macOS automation
 * prompt for the Notes app. If denied, returns a structured error
 * (`apple_notes_permission_denied`) the route surfaces to the UI.
 *
 * Locked notes are skipped (AppleScript can't read their body) with a
 * warning. Pinned notes are imported with `pinned: true`. Inline
 * `#hashtags` in body stay as plain text — we don't auto-create
 * Morion tags from them.
 *
 * Phase 3 v1 limitations (documented as known):
 *   - No attachments (drawings, photos, voice memos, PDFs are not
 *     extracted; the body's HTML may still embed inline base64 images
 *     which turndown converts to data URIs).
 *   - No HEIC conversion. Apple Notes embeds inline images as base64
 *     in the HTML, so HEIC handling is moot for body images. File
 *     attachments aren't imported in v1 anyway.
 *   - Single AppleScript call per phase — large libraries (1000+
 *     notes) may take 30-60 seconds. Concurrency / chunking is
 *     Phase 3.1.
 */

import { PROBE_SCRIPT, buildExportScript } from './applescript.js';
import { runOsascript } from './osascript.js';
import {
  AppleNotesNotInstalledError,
  type AppleNotesExportResult,
  type AppleNotesFolder,
  type AppleNotesNote,
} from './types.js';

// Public types + errors
export {
  AppleNotesPermissionError,
  AppleNotesNotInstalledError,
  type AppleNotesFolder,
  type AppleNotesNote,
  type AppleNotesExportResult,
} from './types.js';
export { htmlToMarkdown } from './html-to-md.js';
export {
  extractInlineImages,
  type ExtractedAppleNotesImage,
  type ExtractInlineImagesResult,
} from './images.js';
export {
  scanAppleNotesExport,
  type AppleNotesScanResult,
} from './scan.js';

/**
 * Probe Apple Notes for the list of folders + per-folder note counts.
 * Used by the UI to render the folder-picker checkbox tree before
 * starting the actual import.
 */
export async function listAppleNotesFolders(): Promise<AppleNotesFolder[]> {
  if (process.platform !== 'darwin') {
    throw new AppleNotesNotInstalledError(
      'Apple Notes import is macOS-only.',
    );
  }
  const stdout = await runOsascript(PROBE_SCRIPT);
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: Array<{
    account: string;
    folder: string;
    path: string;
    count: number;
  }>;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `Failed to parse Apple Notes folder list: ${(err as Error).message}. Output: ${trimmed.slice(0, 200)}`,
    );
  }
  return parsed.map((row) => ({
    accountName: row.account,
    folderName: row.folder,
    folderPath: row.path,
    noteCount: row.count,
  }));
}

/**
 * Export the bodies + metadata for every note in the selected
 * folders. Returns the raw note list — callers convert HTML →
 * markdown and feed into the engine via `scanAppleNotesNotes`.
 */
export async function runAppleNotesExport(input: {
  selectedFolders: Array<{ accountName: string; folderPath: string }>;
  signal?: AbortSignal;
}): Promise<AppleNotesExportResult> {
  if (process.platform !== 'darwin') {
    throw new AppleNotesNotInstalledError(
      'Apple Notes import is macOS-only.',
    );
  }
  if (input.selectedFolders.length === 0) {
    return { notes: [], skippedLocked: [] };
  }
  const script = buildExportScript(input.selectedFolders);
  const stdout = await runOsascript(script, input.signal);
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === '[]') {
    return { notes: [], skippedLocked: [] };
  }
  // Defensive cleanup: AppleScript bugs may have left orphan commas
  // (e.g. `[,,,]` from a v1 bug where the comma-emit ran before the
  // object emit failed). Strip stray empty array slots before
  // parsing — JSON.parse rejects them, but they're not malicious data,
  // just AppleScript artefacts.
  const cleaned = trimmed
    .replace(/,(?=\s*[,\]])/g, '') // empty slots: `,,` → `,`; `,]` → `]`
    .replace(/\[\s*,/g, '['); // leading comma: `[,` → `[`
  let parsed: Array<{
    account: string;
    folderPath: string;
    name: string;
    body: string;
    createdAt: number | string;
    modifiedAt: number | string;
    pinned: boolean;
  }>;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `Failed to parse Apple Notes export output: ${(err as Error).message}. Sample: ${cleaned.slice(0, 200)}`,
    );
  }
  const notes: AppleNotesNote[] = parsed.map((row) => ({
    accountName: row.account,
    folderPath: row.folderPath,
    name: row.name,
    bodyHtml: row.body,
    // Phase 3.0.1: AppleScript now emits ISO 8601 strings to avoid
    // integer overflow on epoch ms. Convert here.
    createdAt: parseDateField(row.createdAt),
    modifiedAt: parseDateField(row.modifiedAt),
    pinned: row.pinned,
  }));
  return { notes, skippedLocked: [] };
}

/**
 * Parse the `createdAt` / `modifiedAt` field. v1 of the AppleScript
 * emitted epoch ms numbers (broken by integer overflow). v2 emits
 * ISO 8601 strings. Accept both for transition compatibility.
 */
function parseDateField(value: number | string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : Date.now();
  }
  return Date.now();
}
