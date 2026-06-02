import { Bot, CheckCircle2, Clock, Loader2, MessageCircle, RefreshCcw, Settings, XCircle } from 'lucide-react';
import type { AutoCodeQueueRow, AutoCodeQueueState } from '../lib/api';
import { cn } from '../lib/cn';

/**
 * Auto-code Phase 3 — kanban-card badge
 * (sub-ticket 01KQEEE8NKFYQ4674A7SF04YNX, umbrella
 * 01KQANTZDKW6QH461AK2JN3DCQ).
 *
 * Tiny state-driven chip rendered on every kanban card that has at
 * least one mo_agent_queue row. Click → parent opens the
 * AutoCodeDrawer for that task. States and colors mirror
 * RunStatusBar inside AutoCodeDrawer so the visual language stays
 * consistent across the two surfaces.
 *
 * Auto-fade for `done`: a card that finished > 24h ago drops the
 * badge entirely (the user already saw the success and the card's
 * status column tells the same story). `failed` / `cancelled`
 * persist forever — those are escalations the user might not have
 * triaged yet.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;

interface BadgeMeta {
  label: string;
  icon: typeof Bot;
  /** Tailwind classes for the chip background + text + border. */
  className: string;
  /** True when the icon should spin (active states). */
  spinning?: boolean;
}

const META: Record<AutoCodeQueueState, BadgeMeta> = {
  pending: {
    label: 'auto-queued',
    icon: Clock,
    className: 'bg-muted text-muted-foreground border-border',
  },
  fix_running: {
    label: 'auto-running',
    icon: Loader2,
    className: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30',
    spinning: true,
  },
  fix_review: {
    label: 'capturing diff',
    icon: Loader2,
    className: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30',
    spinning: true,
  },
  review_running: {
    label: 'auto-reviewing',
    icon: Loader2,
    className: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30',
    spinning: true,
  },
  reopened: {
    label: 'reopened',
    icon: RefreshCcw,
    className: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
  },
  done: {
    label: 'auto-done',
    icon: CheckCircle2,
    className:
      'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  },
  done_merged: {
    label: 'auto-done · merged',
    icon: CheckCircle2,
    className:
      'bg-emerald-600/15 text-emerald-700 dark:text-emerald-300 border-emerald-600/50',
  },
  failed: {
    label: 'auto-paused',
    icon: XCircle,
    className: 'bg-destructive/10 text-destructive border-destructive/30',
  },
  cancelled: {
    label: 'cancelled',
    icon: XCircle,
    className: 'bg-muted text-muted-foreground border-border',
  },
  paused_ask_user: {
    label: 'awaiting your reply',
    icon: MessageCircle,
    className:
      'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30',
  },
};

interface Props {
  /** Latest queue row for the ticket — null when there's no auto-code
   *  activity yet. A null row + `folderAutoCodeEnabled=true` renders
   *  the faint "configure" affordance (ticket
   *  01KRWQPDKQ2RZMDBJZ5KN0B7YE) so the user can open the drawer
   *  and pin a workflow before the first run. */
  row: AutoCodeQueueRow | null;
  /** Note id — passed to `onClick` so the parent can open the drawer
   *  even when there's no row to point at. */
  taskId: string;
  /** True when the folder has auto-code enabled but this ticket has
   *  no run yet — drives the "configure" pill. Ignored when `row`
   *  is non-null (the state-driven pill always wins). */
  folderAutoCodeEnabled?: boolean;
  /** Wall-clock now in ms — pass a stable value when rendering many
   *  cards to keep the auto-fade decision consistent across one
   *  render pass. Defaults to `Date.now()`. */
  now?: number;
  /** Click handler — KanbanView opens the AutoCodeDrawer for the
   *  task. Stops propagation so the card's outer click (open card
   *  modal) doesn't also fire. */
  onClick: (taskId: string) => void;
}

export function AutoCodeBadge({
  row,
  taskId,
  folderAutoCodeEnabled = false,
  now = Date.now(),
  onClick,
}: Props) {
  // No active row — surface the "configure" affordance ONLY when the
  // folder has auto-code enabled. Otherwise render nothing (auto-code
  // disabled folders shouldn't advertise the feature on every card).
  if (!row) {
    if (!folderAutoCodeEnabled) return null;
    const tooltip =
      'Configure Auto-code workflow for this ticket. Opens the drawer.';
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClick(taskId);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        title={tooltip}
        aria-label={tooltip}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none transition-opacity opacity-50 hover:opacity-100',
          'border-dashed border-border bg-transparent text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <Settings className="h-3 w-3" />
        <span className="leading-none">auto-code</span>
      </button>
    );
  }

  // Auto-fade `done` rows after 24h — the success tag is no longer
  // useful once the user has had time to register the result. The
  // kanban column itself is the durable signal at that point.
  if (row.state === 'done' && now - row.updatedAt > DAY_MS) return null;
  // Mid-merge override (Codex 2026-05-12). When state=done AND
  // trunk has stale MERGE_HEAD from THIS run, the kanban card
  // surfaces a distinct amber "mid-merge" pill instead of plain
  // "auto-done" — clicking it opens the drawer where the user
  // resumes / aborts. Without this signal, mid-merge cards looked
  // ready-to-merge from the kanban view; only opening the drawer
  // revealed the stuck state.
  const midMergeOurs =
    row.state === 'done' &&
    row.mergeStatus?.inProgress === true &&
    row.mergeStatus.isOurMerge === true;
  const midMergeForeign =
    row.state === 'done' &&
    row.mergeStatus?.inProgress === true &&
    row.mergeStatus.isOurMerge === false;
  const meta = midMergeOurs
    ? {
        label: 'mid-merge',
        icon: RefreshCcw,
        className:
          'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/40',
        spinning: false,
      }
    : midMergeForeign
      ? {
          label: 'foreign merge',
          icon: XCircle,
          className: 'bg-destructive/10 text-destructive border-destructive/40',
          spinning: false,
        }
      : META[row.state];
  const Icon = meta.icon;
  const reopenSuffix =
    row.state === 'reopened' && row.reopenCount > 0 ? ` ${row.reopenCount}x` : '';
  const midMergeUnresolved =
    midMergeOurs && row.mergeStatus?.inProgress
      ? ` · ${row.mergeStatus.unresolvedCount} unresolved`
      : '';
  const tooltip =
    midMergeOurs
      ? `Mid-merge: trunk has MERGE_HEAD from this run${midMergeUnresolved}. Click to resume or abort.`
      : midMergeForeign
        ? 'Mid-merge: trunk is merging a different branch. Click to inspect / abort.'
        : row.state === 'failed' && row.lastError
          ? `Auto-code paused — ${row.lastError.split('\n')[0]?.slice(0, 200) ?? ''}`
          : row.state === 'reopened' && row.lastError
            ? `Reopened — ${row.lastError.slice(0, 200)}`
            : `Auto-code: ${meta.label}${reopenSuffix}`;
  return (
    <button
      type="button"
      onClick={(e) => {
        // Stop propagation so the card's own click handler (open
        // card modal) doesn't also fire. The badge is a peer-level
        // affordance, not a card-open surface.
        e.stopPropagation();
        onClick(taskId);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      title={tooltip}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        meta.className,
      )}
      aria-label={tooltip}
    >
      <Icon className={cn('h-3 w-3', meta.spinning && 'animate-spin')} />
      <span className="leading-none">
        {meta.label}
        {reopenSuffix}
      </span>
    </button>
  );
}
