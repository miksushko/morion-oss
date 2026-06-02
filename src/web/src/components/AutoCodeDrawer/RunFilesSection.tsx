import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Circle, Loader2 } from 'lucide-react';
import { api, type AutoCodeQueueRow, type AutoCodeRunFilesResult } from '../../lib/api';
import { cn } from '../../lib/cn';
import { FileStatusIcon } from './FileStatusIcon';
import { FileDiffModal } from './FileDiffModal';

/**
 * Collapsible list of files changed by the run with a per-file
 * before/after content modal. Driven by GET /api/auto-code/runs/:id/
 * files (list) and /files/content?path= (per-file body). Fetches
 * lazily on first expand; data cached per row id.
 */
export function RunFilesSection({ row }: { row: AutoCodeQueueRow }) {
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<AutoCodeRunFilesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setSelectedFile(null);
    setExpanded(false);
  }, [row.id]);

  useEffect(() => {
    if (!expanded || data) return;
    let cancelled = false;
    setLoading(true);
    api
      .getAutoCodeRunFiles(row.id)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setData({ ok: false, error: 'fetch_failed', message: (e as Error).message });
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, row.id, data]);

  // Pre-fetch the file list once on mount so the toggle button can
  // show the file count + the empty-state can render without a click.
  useEffect(() => {
    if (data) return;
    let cancelled = false;
    api
      .getAutoCodeRunFiles(row.id)
      .then((d) => {
        if (cancelled) return;
        setData(d);
      })
      .catch(() => {
        // Silent — the on-expand fetcher above will surface the error.
      });
    return () => {
      cancelled = true;
    };
  }, [row.id, data]);

  const fileCount = data && data.ok ? data.files.length : null;
  const totalLabel =
    fileCount === null
      ? 'Files…'
      : fileCount === 0
      ? 'No files changed'
      : `Files (${fileCount}${data && data.ok && data.truncated ? `+` : ''})`;

  return (
    <div className="border-b">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        disabled={fileCount === 0}
        className={cn(
          'flex w-full items-center gap-2 px-4 py-2 text-left text-[12px] font-medium',
          fileCount === 0
            ? 'cursor-not-allowed text-muted-foreground'
            : 'hover:bg-muted/40',
        )}
      >
        {fileCount === 0 ? (
          <Circle className="h-3.5 w-3.5 text-muted-foreground" />
        ) : expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <span>{totalLabel}</span>
        {loading && <Loader2 className="ml-auto h-3 w-3 animate-spin text-muted-foreground" />}
      </button>
      {expanded && data && data.ok && data.files.length > 0 && (
        <div className="border-t bg-muted/10 px-4 py-2">
          <ul className="space-y-0.5 text-[12px]">
            {data.files.map((f) => (
              <li key={`${f.status}:${f.path}`}>
                <button
                  type="button"
                  onClick={() => setSelectedFile(f.path)}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-background"
                  title={`Open before/after for ${f.path}`}
                >
                  <FileStatusIcon status={f.status} />
                  <span className="truncate font-mono text-[11px]">{f.path}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[10px]">
                    {f.binary && (
                      <span className="text-muted-foreground">binary</span>
                    )}
                    {f.additions !== null && f.additions > 0 && (
                      <span className="text-emerald-600 dark:text-emerald-400">+{f.additions}</span>
                    )}
                    {f.deletions !== null && f.deletions > 0 && (
                      <span className="text-rose-600 dark:text-rose-400">−{f.deletions}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {data.truncated && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              … and {data.totalFiles - data.files.length} more file(s). Open
              the repo in your editor to see the full diff.
            </div>
          )}
        </div>
      )}
      {expanded && data && !data.ok && (
        <div className="border-t bg-destructive/5 px-4 py-2 text-[11px] text-destructive">
          Couldn't load file list: {data.message}
        </div>
      )}
      {selectedFile && (
        <FileDiffModal
          runId={row.id}
          repoPath={row.repoPath}
          worktreeName={row.worktreeName}
          path={selectedFile}
          onClose={() => setSelectedFile(null)}
        />
      )}
    </div>
  );
}
