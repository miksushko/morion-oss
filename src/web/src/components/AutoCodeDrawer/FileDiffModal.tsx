import { useEffect, useState } from 'react';
import { Code2, FolderOpen, Loader2, X } from 'lucide-react';
import { api, type AutoCodeFileContentResult } from '../../lib/api';
import { isTauri } from '../../lib/env';
import { openInEditor, revealInFinder } from '../../lib/revealPath';
import { cn } from '../../lib/cn';
import { worktreeFilePath } from './helpers';

/** Modal showing the before / after content for one changed file.
 *  Tabs: "After" (post-change body — what's on the worktree branch)
 *  default-selected, "Before" (target-branch body — what was there
 *  before). Large files show a "Open in editor" CTA instead of
 *  inline body. Binary files show a "Open in Finder" CTA. */
export function FileDiffModal({
  runId,
  repoPath,
  worktreeName,
  path,
  onClose,
}: {
  runId: string;
  repoPath: string;
  worktreeName: string | null;
  path: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState<AutoCodeFileContentResult | null>(null);
  const [side, setSide] = useState<'after' | 'before'>('after');

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    api
      .getAutoCodeFileContent(runId, path)
      .then((r) => {
        if (cancelled) return;
        setContent(r);
      })
      .catch((e) => {
        if (cancelled) return;
        setContent({ ok: false, error: 'fetch_failed', message: (e as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [runId, path]);

  // Absolute filesystem path for the worktree's copy of this file —
  // used for the "Open in editor" CTA when the file is too large to
  // render inline. We point at the WORKTREE copy (where the post-
  // change content lives) rather than repo root so the editor lands
  // on the actual diff result.
  const wtFilePath = worktreeFilePath(repoPath, worktreeName, path);

  const onOpenEditor = async () => {
    try {
      await openInEditor(wtFilePath);
    } catch (err) {
      console.error('openInEditor failed', err);
    }
  };

  const onRevealFolder = async () => {
    try {
      await revealInFinder(wtFilePath);
    } catch (err) {
      console.error('revealInFinder failed', err);
    }
  };

  const body = (() => {
    if (!content)
      return (
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          loading…
        </div>
      );
    if (!content.ok)
      return (
        <div className="m-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-[12px] text-destructive">
          {content.message}
        </div>
      );
    if (content.binary)
      return (
        <div className="m-4 rounded-md border border-border bg-muted/40 p-3 text-[12px]">
          Binary file — can't show a text diff. Open it in Finder or your
          editor to inspect.
          {isTauri && (
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void onRevealFolder()}
                className="flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-[11px] hover:bg-muted"
              >
                <FolderOpen className="h-3 w-3" />
                Reveal in Finder
              </button>
            </div>
          )}
        </div>
      );
    const sideContent = side === 'after' ? content.after : content.before;
    const sideTooLarge = side === 'after' ? content.afterTooLarge : content.beforeTooLarge;
    const sideSize = side === 'after' ? content.afterSize : content.beforeSize;
    if (sideTooLarge)
      return (
        <div className="m-4 rounded-md border border-border bg-muted/40 p-3 text-[12px]">
          File too large for preview
          {sideSize !== null ? ` (${(sideSize / 1024).toFixed(1)} KB, limit 200 KB)` : ''}.
          Open it in your editor.
          {isTauri && (
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void onOpenEditor()}
                className="flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-[11px] hover:bg-muted"
              >
                <Code2 className="h-3 w-3" />
                Open in editor
              </button>
              <button
                type="button"
                onClick={() => void onRevealFolder()}
                className="flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-[11px] hover:bg-muted"
              >
                <FolderOpen className="h-3 w-3" />
                Reveal in Finder
              </button>
            </div>
          )}
        </div>
      );
    if (sideContent === null)
      return (
        <div className="m-4 rounded-md border border-border bg-muted/40 p-3 text-[12px] text-muted-foreground">
          {side === 'before' && content.status === 'A'
            ? 'File was new — no "before" content.'
            : side === 'after' && content.status === 'D'
            ? 'File was deleted — no "after" content.'
            : 'Content unavailable.'}
        </div>
      );
    return (
      <pre className="m-0 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11px] leading-relaxed text-foreground">
        {sideContent}
      </pre>
    );
  })();

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg border border-border bg-background shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {content && content.ok ? `${content.status} · ${content.branchName} ↔ ${content.targetBranch}` : 'Loading'}
            </div>
            <div className="mt-0.5 truncate font-mono text-sm">{path}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <button
            type="button"
            onClick={() => setSide('after')}
            className={cn(
              'rounded px-2.5 py-1 text-[12px]',
              side === 'after'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted',
            )}
          >
            After
          </button>
          <button
            type="button"
            onClick={() => setSide('before')}
            className={cn(
              'rounded px-2.5 py-1 text-[12px]',
              side === 'before'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted',
            )}
          >
            Before
          </button>
          {isTauri && (
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => void onOpenEditor()}
                className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-muted"
                title={`Open ${wtFilePath} in editor`}
              >
                <Code2 className="h-3 w-3" />
                Editor
              </button>
              <button
                type="button"
                onClick={() => void onRevealFolder()}
                className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-muted"
                title={`Reveal ${wtFilePath} in Finder`}
              >
                <FolderOpen className="h-3 w-3" />
                Finder
              </button>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-auto">{body}</div>
      </div>
    </div>
  );
}
