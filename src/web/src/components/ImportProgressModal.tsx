import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X, FolderOpen, FileText, AlertCircle, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api';
import { getApiBaseSync, getApiToken } from '../lib/env';

/**
 * Import progress modal — consumes the SSE stream for an active
 * import batch and shows live progress + final summary.
 *
 * Mounted by the parent (App / HeaderMenu trigger) via a controlled
 * `batchId` prop. When `batchId` is non-null, this opens an SSE
 * connection to `GET /api/import/:batchId/stream`, replays buffered
 * events on connect, then forwards live updates until the batch
 * completes / cancels / errors.
 *
 * Cancel button calls `POST /api/import/:batchId/cancel` — already-
 * imported notes stay; pending entries drop.
 */

interface Props {
  batchId: string | null;
  onClose: () => void;
  /** Called when user clicks "Open imported folder" in the success state.
   *  Parent navigates to that folder. */
  onOpenFolder?: (folderId: string) => void;
}

interface ImportEvent {
  type: 'start' | 'progress' | 'error' | 'complete' | 'cancelled';
  batchId: string;
  total?: number;
  done?: number;
  errored?: number;
  /** Optional human-readable phase label — Apple Notes import sets
   *  this during osascript so the modal isn't silent. */
  phase?: string;
  error?: { file: string; message: string };
  file?: { sourceFile: string; noteId: string; folderId: string | null };
  summary?: {
    batchId: string;
    source: string;
    total: number;
    imported: number;
    errored: number;
    cancelled: boolean;
    rootFolderId: string | null;
    errors: Array<{ file: string; message: string }>;
  };
}

export function ImportProgressModal({ batchId, onClose, onOpenFolder }: Props) {
  const [events, setEvents] = useState<ImportEvent[]>([]);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [errored, setErrored] = useState(0);
  const [phase, setPhase] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [summary, setSummary] = useState<ImportEvent['summary'] | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const evtRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!batchId) return;
    setEvents([]);
    setDone(0);
    setTotal(0);
    setErrored(0);
    setPhase(null);
    setFinished(false);
    setSummary(null);

    // EventSource doesn't support custom headers in the standard browser
    // API. We pass the auth token as a query param fallback. The server
    // accepts both X-Morion-Token header and ?token query for SSE.
    //
    // (Safer than the raw fetch+ReadableStream parse path because all
    // browsers cache reconnect logic for EventSource.)
    const token = getApiToken();
    const url = `${getApiBaseSync()}/api/import/${encodeURIComponent(batchId)}/stream${
      token ? `?token=${encodeURIComponent(token)}` : ''
    }`;
    const es = new EventSource(url);
    evtRef.current = es;

    const handle = (e: MessageEvent): void => {
      try {
        const event = JSON.parse(e.data) as ImportEvent;
        setEvents((prev) => [...prev, event]);
        if (event.type === 'start' && event.total !== undefined) {
          setTotal(event.total);
        }
        if (event.type === 'progress') {
          if (event.done !== undefined) setDone(event.done);
          if (event.total !== undefined) setTotal(event.total);
          if (event.errored !== undefined) setErrored(event.errored);
          if (event.phase !== undefined) setPhase(event.phase);
          // First real progress with `total > 0` clears the phase
          // label — we're past the pre-processing step now.
          else if ((event.total ?? 0) > 0) setPhase(null);
        }
        if (event.type === 'error') {
          if (event.errored !== undefined) setErrored(event.errored);
        }
        if (event.type === 'complete' || event.type === 'cancelled') {
          setFinished(true);
          if (event.summary) setSummary(event.summary);
          es.close();
        }
      } catch {
        // ignore unparseable payloads
      }
    };

    // Listen for all our event types. The server uses `event:` field
    // to discriminate. `message` is the default for un-typed events.
    es.addEventListener('start', handle);
    es.addEventListener('progress', handle);
    es.addEventListener('error', handle);
    es.addEventListener('complete', handle);
    es.addEventListener('cancelled', handle);
    es.addEventListener('message', handle);

    es.onerror = () => {
      // Server ended the stream cleanly OR network error — either way,
      // surface as finished if we haven't already seen a complete event.
      if (!finished) {
        setFinished(true);
      }
    };

    return () => {
      es.close();
      evtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  if (!batchId) return null;

  const handleCancel = async (): Promise<void> => {
    setCancelling(true);
    try {
      await api.cancelImport(batchId);
    } finally {
      setCancelling(false);
    }
  };

  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-progress-title"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40"
    >
      <div className="w-[480px] max-w-[90vw] rounded-lg border border-border bg-card text-sm text-foreground shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            {!finished && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
            {finished && summary?.cancelled && (
              <AlertCircle className="h-4 w-4 text-amber-500" />
            )}
            {finished && summary && !summary.cancelled && (
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            )}
            <h2 id="import-progress-title" className="font-semibold">
              {finished
                ? summary?.cancelled
                  ? 'Import cancelled'
                  : 'Import complete'
                : 'Importing…'}
            </h2>
          </div>
          {finished && (
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-4 py-4">
          {!finished && (
            <>
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-foreground">
                  {total === 0 && phase
                    ? phase
                    : `${done} of ${total} imported`}
                </span>
                <span className="text-muted-foreground">
                  {total === 0 ? '' : `${pct}%`}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-accent">
                <div
                  className={
                    total === 0
                      ? 'h-full w-1/3 animate-pulse bg-primary/60'
                      : 'h-full bg-primary transition-all'
                  }
                  style={total === 0 ? undefined : { width: `${pct}%` }}
                />
              </div>
              {errored > 0 && (
                <div className="mt-3 flex items-center gap-2 text-xs text-amber-600">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {errored} file{errored === 1 ? '' : 's'} failed
                </div>
              )}
            </>
          )}

          {finished && summary && (
            <>
              <div className="space-y-1 text-foreground">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                  <span>
                    {summary.imported} note{summary.imported === 1 ? '' : 's'} imported
                  </span>
                </div>
                {summary.errored > 0 && (
                  <div className="flex items-center gap-2 text-amber-600">
                    <AlertCircle className="h-3.5 w-3.5" />
                    <span>
                      {summary.errored} file{summary.errored === 1 ? '' : 's'} failed
                    </span>
                  </div>
                )}
                {summary.cancelled && (
                  <div className="text-xs text-muted-foreground">
                    Batch cancelled — already-imported notes were kept.
                  </div>
                )}
              </div>
              {summary.errors.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    Show {summary.errors.length} error{summary.errors.length === 1 ? '' : 's'}
                  </summary>
                  <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto rounded-md bg-accent/30 p-2 text-xs">
                    {summary.errors.map((e, i) => (
                      <li key={i} className="truncate">
                        <span className="font-mono text-muted-foreground">
                          {e.file.split('/').pop()}
                        </span>
                        : {e.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          {!finished && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelling}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-50"
            >
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {finished && summary?.rootFolderId && onOpenFolder && (
            <button
              type="button"
              onClick={() => {
                onOpenFolder(summary.rootFolderId!);
                onClose();
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Open imported folder
            </button>
          )}
          {finished && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Small marker so unused-import warnings stay quiet on icon imports we
// might add later for the trigger dialog.
const _icons = { FileText };
void _icons;
