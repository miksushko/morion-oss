import { useEffect, useRef, useState } from 'react';
import { Loader2, MoreHorizontal, Trash2 } from 'lucide-react';
import {
  api,
  type AutoCodeQueueRow,
  type AutoCodeQueueState,
} from '../../lib/api';
import { cn } from '../../lib/cn';

/**
 * Ticket 01KRFX0PNE4WAFTDYJ3FQPK8F7 — small "⋯" More menu next to
 * the Show files / Open in editor buttons. Currently has one entry:
 * **Delete worktree**, gated on non-active states. For `done` runs
 * with unmerged changes a confirm dialog warns the user before the
 * destructive remove (backend doesn't refuse done; the user owns
 * the call).
 *
 * Hidden entirely on `pending` / `fix_running` / `fix_review` /
 * `review_running` / `reopened` / `paused_ask_user` because there
 * is nothing to delete safely while the runner is in flight.
 */
export function RunMoreMenu({
  row,
  pinRightWhenNoPathActions,
}: {
  row: AutoCodeQueueRow;
  pinRightWhenNoPathActions: boolean;
}) {
  const ACTIVE: AutoCodeQueueState[] = [
    'pending',
    'fix_running',
    'fix_review',
    'review_running',
    'reopened',
    'paused_ask_user',
  ];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (ACTIVE.includes(row.state)) return null;
  if (!row.worktreeName) return null; // nothing to delete — never had a worktree

  const onDelete = async () => {
    setErr(null);
    // Warning for unmerged work — `done` without `done_merged` means
    // the agent finished but the user hasn't clicked Merge. Be
    // explicit so they don't drop work by accident.
    if (row.state === 'done') {
      const ok = window.confirm(
        `This run finished but hasn't been merged into main.\n\nThe worktree contains the agent's diff — deleting it will discard those changes.\n\nReally delete worktree \`${row.worktreeName}\`?`,
      );
      if (!ok) return;
    } else {
      const ok = window.confirm(
        `Delete worktree \`${row.worktreeName}\`?\n\nThis runs \`git worktree remove --force\` on the linked repo. The auto-code branch ref is preserved so the merge history stays inspectable.`,
      );
      if (!ok) return;
    }
    setBusy(true);
    setOpen(false);
    try {
      const r = await api.removeAutoCodeRunWorktree(row.id);
      if (r.ok) {
        if (!r.removed) {
          setErr(
            r.reason === 'already_gone'
              ? 'Worktree was already gone.'
              : 'No worktree was ever provisioned for this run.',
          );
        }
        // Success: the kanban row poll will refresh on its own; the
        // drawer state-bar shows the existing path label until the
        // next 5s tick re-renders.
      } else {
        setErr(r.message ?? `Failed: ${r.error}`);
      }
    } catch (e) {
      setErr((e as Error).message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className={cn('relative', pinRightWhenNoPathActions && 'ml-auto')}
    >
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        disabled={busy}
        className="flex items-center justify-center rounded-md border border-border bg-background px-1.5 py-1 text-foreground hover:bg-muted disabled:opacity-50"
        title="More actions"
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <MoreHorizontal className="h-3 w-3" />
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 min-w-[200px] rounded-md border border-border bg-background py-1 shadow-md">
          <button
            type="button"
            onClick={() => void onDelete()}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3 w-3" />
            Delete worktree
          </button>
        </div>
      )}
      {err && (
        <div className="absolute right-0 top-full z-10 mt-9 min-w-[240px] rounded-md border border-destructive/30 bg-destructive/10 p-2 text-[11px] text-destructive shadow-md">
          {err}
        </div>
      )}
    </div>
  );
}
