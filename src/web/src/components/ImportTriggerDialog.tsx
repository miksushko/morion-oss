import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, FileText, FolderOpen, FolderTree } from 'lucide-react';
import { api } from '../lib/api';

/**
 * Entry-point dialog for starting an import.
 *
 * Two real OS file pickers — single file and folder — via standard
 * browser `<input type="file">` elements. Bytes are uploaded as
 * multipart/form-data with each file part keyed `file:<relPath>`
 * so the server can rebuild the directory structure.
 *
 * Single-file picker: standard `<input type="file" accept=".md,...">`.
 * Folder picker: `<input type="file" webkitdirectory>` — supported
 * on every modern browser including Tauri's WebKit. Returns the
 * full file tree with `webkitRelativePath` populated.
 *
 * No Tauri-specific dialog plugin needed — works in dev (browser)
 * AND in Tauri webview without code changes. A future native menu
 * could call this same handler with a synthesised `FileList`.
 */

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the new batchId once the server accepts the upload. */
  onStarted: (batchId: string) => void;
  /** Open the Apple Notes folder picker (macOS only). */
  onOpenAppleNotes?: () => void;
}

const isMacOS =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform);

const SUPPORTED_EXTENSIONS = '.md,.markdown,.txt,.docx';

export function ImportTriggerDialog({ open, onClose, onStarted, onOpenAppleNotes }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const reset = (): void => {
    setSubmitting(false);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (folderInputRef.current) folderInputRef.current.value = '';
  };

  const handleFiles = async (
    fileList: FileList | null,
    mode: 'file' | 'folder',
  ): Promise<void> => {
    if (!fileList || fileList.length === 0) return;

    // For folder mode, filter to supported extensions client-side so
    // we don't upload images, .DS_Store, etc.
    const files: File[] = [];
    const supportedExts = SUPPORTED_EXTENSIONS.split(',');
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList.item(i);
      if (!f) continue;
      const lowerName = f.name.toLowerCase();
      const matchesExt = supportedExts.some((ext) => lowerName.endsWith(ext));
      if (matchesExt) files.push(f);
    }

    if (files.length === 0) {
      setError(
        mode === 'folder'
          ? 'No .md / .markdown / .txt files found in the selected folder.'
          : 'Selected file is not a supported format. Pick .md / .markdown / .txt.',
      );
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await api.startImportUpload({ mode, files });
      if (res.ok) {
        onStarted(res.batchId);
        reset();
        onClose();
      } else if (res.error === 'import_in_progress') {
        setError(
          res.message ?? 'Another import is already running. Wait for it to finish.',
        );
      } else {
        setError(res.message ?? `Import failed: ${res.error}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-trigger-title"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="w-[480px] max-w-[90vw] rounded-lg border border-border bg-card text-sm text-foreground shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id="import-trigger-title" className="font-semibold">
            Import File
          </h2>
          <button
            type="button"
            aria-label="Close"
            disabled={submitting}
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          <p className="text-xs text-muted-foreground">
            Pick a single <code className="rounded bg-accent/40 px-1 py-0.5 font-mono">.md</code> /{' '}
            <code className="rounded bg-accent/40 px-1 py-0.5 font-mono">.markdown</code> /{' '}
            <code className="rounded bg-accent/40 px-1 py-0.5 font-mono">.txt</code> /{' '}
            <code className="rounded bg-accent/40 px-1 py-0.5 font-mono">.docx</code> file, or a
            whole folder (subfolders are mirrored as Morion folders).
          </p>

          <div
            className={
              isMacOS && onOpenAppleNotes
                ? 'grid grid-cols-3 gap-2'
                : 'grid grid-cols-2 gap-2'
            }
          >
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={submitting}
              className="flex flex-col items-center gap-2 rounded-lg border border-border bg-background p-4 text-center transition-colors hover:bg-accent disabled:opacity-50"
            >
              <FileText className="h-6 w-6 text-primary" />
              <div className="text-sm font-medium">Single file</div>
              <div className="text-[11px] text-muted-foreground">
                .md / .markdown / .txt / .docx
              </div>
            </button>
            <button
              type="button"
              onClick={() => folderInputRef.current?.click()}
              disabled={submitting}
              className="flex flex-col items-center gap-2 rounded-lg border border-border bg-background p-4 text-center transition-colors hover:bg-accent disabled:opacity-50"
            >
              <FolderOpen className="h-6 w-6 text-primary" />
              <div className="text-sm font-medium">Folder</div>
              <div className="text-[11px] text-muted-foreground">
                Includes subfolders
              </div>
            </button>
            {isMacOS && onOpenAppleNotes && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenAppleNotes();
                }}
                disabled={submitting}
                className="flex flex-col items-center gap-2 rounded-lg border border-border bg-background p-4 text-center transition-colors hover:bg-accent disabled:opacity-50"
              >
                <FolderTree className="h-6 w-6 text-primary" />
                <div className="text-sm font-medium">Apple Notes</div>
                <div className="text-[11px] text-muted-foreground">
                  Pick folders
                </div>
              </button>
            )}
          </div>

          {/* Hidden inputs that the buttons trigger. webkitdirectory is the
              folder picker; the regular accept-list is the single-file picker. */}
          <input
            ref={fileInputRef}
            type="file"
            accept={SUPPORTED_EXTENSIONS}
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files, 'file')}
          />
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error — non-standard but supported in every modern browser.
            webkitdirectory=""
            // @ts-expect-error — same as above; React types don't ship this attr.
            directory=""
            multiple
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files, 'folder')}
          />

          {submitting && (
            <div className="rounded-md border border-border bg-accent/30 p-2 text-xs text-muted-foreground">
              Uploading… (large folders may take a few seconds)
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
