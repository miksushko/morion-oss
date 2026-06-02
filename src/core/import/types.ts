/**
 * Mo Indexing — Import from external sources (Phase 1 — markdown).
 *
 * Public types shared across the import module + HTTP route + Tauri
 * bridge. Format-specific handlers (markdown / docx / Apple Notes)
 * emit `ImportEntry` items into the batch queue; the engine drains
 * them in folder-before-files order with bounded concurrency,
 * emitting progress events that the SSE bridge forwards to the web UI.
 */

export type ImportSource = 'import:markdown' | 'import:apple-notes' | 'import:docx';

export interface ImportEntryFolder {
  kind: 'folder';
  /** Absolute path of the source folder on disk (informational only). */
  sourcePath: string;
  /** Relative path under the root being imported. Empty string for the root folder. */
  relPath: string;
  /** Resolved Morion folder id once `engine` creates it. Filled by the queue. */
  folderId?: string;
}

export interface ImportEntryFile {
  kind: 'file';
  /** Absolute path of the source file on disk. */
  sourcePath: string;
  /** Relative path under the root being imported. */
  relPath: string;
  /** Bytes already read by the format scanner; null = read on dequeue. */
  preReadBytes: string | null;
  /** Parent folder relPath (string-keyed for queue resolution), or null for root drop. */
  parentRelPath: string | null;
}

export type ImportEntry = ImportEntryFolder | ImportEntryFile;

export interface ImportEvent {
  type: 'start' | 'progress' | 'error' | 'complete' | 'cancelled';
  /** Stable id stamped by the engine on `start`; carried on every subsequent event. */
  batchId: string;
  /** Total number of file-kind entries the engine plans to process. Set on `start`. */
  total?: number;
  /** Files completed successfully so far. */
  done?: number;
  /** Number of errors so far. */
  errored?: number;
  /** Per-file error detail (only on `type='error'`). */
  error?: { file: string; message: string };
  /** Per-file success detail (only on `type='progress'`). */
  file?: { sourceFile: string; noteId: string; folderId: string | null };
  /** Optional human-readable phase label (e.g. "Reading from Apple
   *  Notes…"). Apple Notes import has a multi-second osascript step
   *  before any file is touched; the modal shows this label in place
   *  of the otherwise-silent "0 of 0 imported" initial state. */
  phase?: string;
  /** Final summary (only on `type='complete'`). */
  summary?: ImportSummary;
}

export interface ImportSummary {
  batchId: string;
  source: ImportSource;
  total: number;
  imported: number;
  errored: number;
  cancelled: boolean;
  /** Top-level Morion folder id for folder-mode imports; null for single-file. */
  rootFolderId: string | null;
  errors: Array<{ file: string; message: string }>;
}

export interface ImportEngineOptions {
  /** Source identifier for `notes.source`. Default: 'import:markdown'. */
  source?: ImportSource;
  /** Max parallel file writes inside one batch. Default: 5. DB write throughput
   *  is the bottleneck; higher values risk SQLITE_BUSY. */
  fileConcurrency?: number;
}
