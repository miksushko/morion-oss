import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, RotateCcw, Copy as CopyIcon } from 'lucide-react';
import { api, type NoteRevision } from '../lib/api';
import { cn } from '../lib/cn';

interface Props {
  noteId: string;
  /** Anchor element — the popover positions itself below it. */
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  /**
   * Restore the historical state into the live note. Parent owns the API
   * call so it can refresh local note state + show a toast in one place.
   */
  onRestore: (revision: NoteRevision) => Promise<void> | void;
  /** Quick clipboard copy of the historical body. Parent fires the toast. */
  onCopy: (revision: NoteRevision) => Promise<void> | void;
}

/**
 * Version-history popover anchored to the editor footer's "Edited X" button.
 * Fetches the revision list when opened, renders one row per revision with a
 * relative timestamp, the actor that wrote it, a body preview, and Restore +
 * Copy buttons.
 *
 * Layout matches the other portal popovers in the codebase (FolderActionsMenu,
 * NoteActionsMenu): createPortal to body, clamped to the viewport, dismisses
 * on backdrop click + Escape. The popover refetches every time it opens so
 * the user sees the latest history (an MCP write that happened in the
 * background between open/close cycles is reflected immediately).
 */
export function RevisionsPopover({
  noteId,
  anchor,
  open,
  onClose,
  onRestore,
  onCopy,
}: Props) {
  const [revisions, setRevisions] = useState<NoteRevision[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Anchor positioning. Recomputed every time the popover opens — the editor
  // footer never moves while the popover is up, so a one-shot calc is enough.
  useLayoutEffect(() => {
    if (!open || !anchor) {
      setPos(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    // Default: open upward from the footer button. The popover is ~360x320
    // and we want it to land above the button without crossing the viewport
    // top.
    const POPOVER_W = 380;
    const POPOVER_MAX_H = 380;
    const x = Math.min(rect.right - POPOVER_W, window.innerWidth - POPOVER_W - 8);
    const y = Math.max(8, rect.top - POPOVER_MAX_H - 8);
    setPos({ x: Math.max(8, x), y });
  }, [open, anchor]);

  // Fetch on open. We deliberately don't cache across open/close so a quick
  // close-and-reopen always gets the latest state.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listRevisions(noteId)
      .then((list) => {
        if (!cancelled) setRevisions(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, noteId]);

  // Outside-click + Escape dismissal. The anchor itself is excluded so
  // clicking the footer button to close the popover works the same as
  // clicking it to open one.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      if (anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchor]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Version history"
      className="fixed z-50 w-[380px] max-h-[380px] flex flex-col rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
        <History className="h-3.5 w-3.5" />
        <span>Version history</span>
        {revisions && revisions.length > 0 && (
          <span className="ml-auto tabular-nums">{revisions.length}</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</div>
        )}
        {error && !loading && (
          <div className="px-3 py-6 text-center text-xs text-destructive">{error}</div>
        )}
        {!loading && !error && revisions && revisions.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No history yet. Edits are checkpointed when you switch away from a note.
          </div>
        )}
        {!loading && !error && revisions && revisions.length > 0 && (
          <ul className="divide-y divide-border">
            {revisions.map((rev) => (
              <RevisionRow
                key={rev.id}
                revision={rev}
                onRestore={onRestore}
                onCopy={onCopy}
              />
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}

interface RowProps {
  revision: NoteRevision;
  onRestore: (revision: NoteRevision) => Promise<void> | void;
  onCopy: (revision: NoteRevision) => Promise<void> | void;
}

function RevisionRow({ revision, onRestore, onCopy }: RowProps) {
  const preview = revision.body.trim().slice(0, 140);
  return (
    <li className="group px-3 py-2 hover:bg-accent/40">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-medium text-foreground">
          {formatRelativeTime(revision.createdAt)}
        </span>
        <div className="flex items-center gap-1.5">
          {revision.kind === 'baseline' && (
            <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              baseline
            </span>
          )}
          <span className="text-muted-foreground">{actorLabel(revision.actor)}</span>
        </div>
      </div>
      <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
        {preview || <span className="italic">empty body</span>}
      </div>
      <div className="mt-1.5 flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={() => onCopy(revision)}
          className={cn(
            'inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11px] text-muted-foreground',
            'hover:bg-accent hover:text-foreground',
          )}
        >
          <CopyIcon className="h-3 w-3" />
          Copy
        </button>
        <button
          type="button"
          onClick={() => onRestore(revision)}
          className={cn(
            'inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11px] text-foreground',
            'hover:bg-accent',
          )}
        >
          <RotateCcw className="h-3 w-3" />
          Restore
        </button>
      </div>
    </li>
  );
}

/**
 * Pretty-print a revision actor for the popover. The audit log stores
 * `user` for hand edits and `mcp:<client-name>` for everything else; the
 * popover wants something a human can read at a glance.
 */
function actorLabel(actor: string): string {
  if (actor === 'user') return 'You';
  if (actor.startsWith('mcp:')) {
    const raw = actor.slice(4);
    if (!raw) return 'MCP';
    // Title-case the client name so "claude-desktop" → "Claude Desktop".
    return raw
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(' ');
  }
  return actor;
}

/**
 * Compact relative-time formatter — "just now / 12m ago / 3h ago / Yesterday
 * / 4d ago / Mar 5". Mirrors the style used in NotesList row timestamps so
 * the popover doesn't introduce a second time grammar.
 */
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 2 * day) return 'Yesterday';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
