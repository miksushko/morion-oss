import { ulid } from 'ulid';
import { EventEmitter } from 'node:events';
import { dirname } from 'node:path';
import type { NotesRepository } from '../notes/repository.js';
import type { FoldersRepository } from '../folders/repository.js';
import type { AttachmentsRepository } from '../attachments/repository.js';
import {
  scanMarkdownFile,
  scanMarkdownFolder,
} from './formats/markdown.js';
import {
  scanUploadedFile,
  scanUploadedFolder,
  type UploadedFile,
} from './formats/markdown-upload.js';
import {
  runAppleNotesExport,
  scanAppleNotesExport,
} from './formats/apple-notes/index.js';
import { ensureTitlePrefix, runWithConcurrency } from './engine/helpers.js';
import { finaliseUploadImages } from './engine/upload-images.js';
import { processScan } from './engine/process-scan.js';
import type {
  ImportEngineOptions,
  ImportEvent,
  ImportSource,
  ImportSummary,
} from './types.js';

/**
 * Single in-process import engine.
 *
 * Lifecycle for one import:
 *   1. Format scanner produces an ordered list of `ImportEntry` items
 *      (folders parent-before-child, then files within each folder).
 *   2. Engine creates the top-level Morion folder (or null for single
 *      file) via `FolderResolver`.
 *   3. Engine drains entries: folder entries resolve sequentially
 *      (cheap, single SQL insert each); file entries dispatch via a
 *      bounded-concurrency pool.
 *   4. Each file event emits `progress` with a `done / total` count.
 *      Errors emit `error` events and continue. `cancel()` flips a
 *      flag — in-flight writes finish, queue drains stop.
 *   5. After the last event, engine emits `complete` with a final
 *      `ImportSummary`.
 *
 * The engine is **single-batch** — call `runMarkdownFile` /
 * `runMarkdownFolder` and consume the EventEmitter through completion.
 * The `ImportRegistry` (separate file) coordinates the global
 * "one-active-batch" invariant across HTTP requests.
 *
 * Module layout (engine = composition shell under the 500-LOC cap):
 *   - `./engine/helpers.ts` — runWithConcurrency, ensureTitlePrefix,
 *     countWords, escapeRegex
 *   - `./engine/upload-images.ts` — post-import attachment stitching
 *     for .docx / Apple Notes inline images
 *   - `./engine/process-scan.ts` — core scan → notes pipeline
 *   - this file — entry points + per-format dispatch + cancellation
 */

const DEFAULT_FILE_CONCURRENCY = 5;

export interface RunMarkdownInput {
  /** Absolute path to file (single mode) or folder (folder mode). */
  absPath: string;
  mode: 'file' | 'folder';
}

export type RunMarkdownUploadInput =
  | { mode: 'file'; file: UploadedFile }
  | { mode: 'folder'; files: UploadedFile[] };

export class ImportEngine {
  /** Emits `ImportEvent` instances. Subscribe with `engine.events.on('event', cb)`. */
  readonly events: EventEmitter;
  private cancelled = false;
  /** Forwarded to long-running child processes (e.g. osascript for
   *  Apple Notes export). engine.cancel() aborts → child gets
   *  SIGTERM → import unwinds promptly instead of waiting for the
   *  5-minute hardcoded osascript timeout. Without this, a stuck
   *  AppleScript run blocks the import registry indefinitely (the
   *  IIFE in routes/import.ts keeps awaiting the spawn promise). */
  private readonly abortController = new AbortController();
  private readonly batchId: string;
  private source: ImportSource;
  private readonly fileConcurrency: number;
  /** Optional attachments repo + configDir — Phase 2 enables image
   *  attachment importing. When omitted, image refs are sanitised
   *  through the body but no inline attachments are imported (they
   *  remain as broken refs to source-disk paths). */
  private readonly attachments: AttachmentsRepository | null;
  private readonly configDir: string | null;

  constructor(
    private readonly notes: NotesRepository,
    private readonly folders: FoldersRepository,
    private readonly actor: string,
    options: ImportEngineOptions & {
      attachments?: AttachmentsRepository;
      configDir?: string;
    } = {},
  ) {
    this.events = new EventEmitter();
    this.batchId = ulid();
    this.source = options.source ?? 'import:markdown';
    this.fileConcurrency = Math.max(1, options.fileConcurrency ?? DEFAULT_FILE_CONCURRENCY);
    this.attachments = options.attachments ?? null;
    this.configDir = options.configDir ?? null;
  }

  get id(): string {
    return this.batchId;
  }

  /** Cancel the import — already-imported items stay; pending entries are
   *  dropped after current in-flight writes settle. Also aborts any
   *  long-running child process (osascript for Apple Notes) so the
   *  registry releases promptly. */
  cancel(): void {
    this.cancelled = true;
    this.abortController.abort();
  }

  async run(input: RunMarkdownInput): Promise<ImportSummary> {
    const scan = input.mode === 'file'
      ? scanMarkdownFile(input.absPath)
      : scanMarkdownFolder(input.absPath);

    // Import root for path-traversal guard on attachment refs.
    // - Folder mode: the source folder itself
    // - File mode: the source file's parent dir
    const importRoot =
      input.mode === 'folder' ? input.absPath : dirname(input.absPath);

    return this.runProcessScan(scan, importRoot);
  }

  /**
   * Run from Apple Notes — runs the AppleScript export for the
   * picked folders, converts every note's HTML body to markdown
   * via turndown, and feeds into the standard processScan flow.
   * macOS-only; throws if not on darwin.
   */
  async runFromAppleNotes(input: {
    selectedFolders: Array<{ accountName: string; folderPath: string }>;
  }): Promise<ImportSummary> {
    // eslint-disable-next-line no-console
    console.log(
      `[apple-notes] runFromAppleNotes start batchId=${this.batchId} folders=${JSON.stringify(input.selectedFolders)}`,
    );
    // Phase indicator — osascript can run for many seconds on big
    // libraries. Emit a synthetic progress event so the modal can
    // show "Reading from Apple Notes…" instead of the silent
    // "0 of 0 imported" placeholder while we wait.
    this.emit({
      type: 'progress',
      batchId: this.batchId,
      done: 0,
      total: 0,
      errored: 0,
      phase: 'Reading from Apple Notes…',
    });
    const exportResult = await runAppleNotesExport({
      ...input,
      signal: this.abortController.signal,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[apple-notes] export returned notes=${exportResult.notes.length} skippedLocked=${exportResult.skippedLocked.length}`,
    );
    this.emit({
      type: 'progress',
      batchId: this.batchId,
      done: 0,
      total: 0,
      errored: 0,
      phase: 'Processing notes…',
    });
    const scan = scanAppleNotesExport(exportResult);
    // eslint-disable-next-line no-console
    console.log(
      `[apple-notes] scan built entries=${scan.entries.length} (folders + files)`,
    );
    // Override source so audit / DB rows discriminate Apple Notes
    // imports from generic markdown uploads.
    const previousSource = this.source;
    this.source = 'import:apple-notes';
    try {
      const summary = await this.runProcessScan(scan, '/__apple-notes-no-root__');
      // Stitch in inline `data:` images extracted from each note's
      // HTML body. Same finaliseUploadImages call site as docx —
      // attachments end up as `morion://attachment/<id>` refs in the
      // body, base64 blobs leave the notes table.
      if (scan.perFileImages && this.attachments && this.configDir) {
        await finaliseUploadImages({
          perFileImages: scan.perFileImages,
          notes: this.notes,
          attachments: this.attachments,
          configDir: this.configDir,
          actor: this.actor,
        });
      }
      // Surface conversion warnings as final summary errors so the UI
      // shows them in the modal's collapsed details.
      for (const w of scan.conversionWarnings) {
        summary.errors.push({ file: w.name, message: w.message });
      }
      return summary;
    } finally {
      this.source = previousSource;
    }
  }

  async runFromUpload(input: RunMarkdownUploadInput): Promise<ImportSummary> {
    const scan =
      input.mode === 'file'
        ? await scanUploadedFile(input.file)
        : await scanUploadedFolder(input.files);
    // No filesystem importRoot for uploads — pass empty so the
    // attachments processor's `isInsideRoot` guard treats every
    // image ref as outside the root and skips with warning. (Phase
    // 2.5 will pre-process uploaded image bytes through the same
    // FormData stream so this becomes useful.)
    const summary = await this.runProcessScan(scan, '/__upload-no-root__');

    // Phase 4: stitch in-memory images extracted during docx
    // conversion onto the corresponding notes. We do this here
    // (rather than inside processScan) because processScan's flow
    // is shared with fs-based imports where image extraction is
    // disk-based. For uploads we hand-write attachment rows post-hoc.
    if (scan.perFileImages && this.attachments && this.configDir) {
      await finaliseUploadImages({
        perFileImages: scan.perFileImages,
        notes: this.notes,
        attachments: this.attachments,
        configDir: this.configDir,
        actor: this.actor,
      });
    }
    if (scan.perFileWarnings) {
      for (const [file, msgs] of scan.perFileWarnings) {
        for (const message of msgs) {
          summary.errors.push({ file, message });
          summary.errored++;
        }
      }
    }
    return summary;
  }

  private runProcessScan(
    scan: Parameters<typeof processScan>[1],
    importRoot: string,
  ): Promise<ImportSummary> {
    return processScan(
      {
        notes: this.notes,
        folders: this.folders,
        attachments: this.attachments,
        configDir: this.configDir,
        actor: this.actor,
        batchId: this.batchId,
        source: this.source,
        fileConcurrency: this.fileConcurrency,
        isCancelled: () => this.cancelled,
        emit: (ev) => this.emit(ev),
      },
      scan,
      importRoot,
    );
  }

  private emit(event: ImportEvent): void {
    this.events.emit('event', event);
  }
}

/** Test-only re-export. */
export const __test = { runWithConcurrency, ensureTitlePrefix };
