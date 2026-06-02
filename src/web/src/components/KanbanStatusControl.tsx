import type { NoteStatus } from '../lib/api';
import { NOTE_STATUSES } from '../lib/api';
import { cn } from './../lib/cn';

/**
 * Inline status-picker shown inside the kanban card modal. Six-wide pill
 * row: clicking the current status is a no-op, clicking any other fires
 * `onChange` so the parent can call the server-side kanban-move and the
 * card reshuffles behind the modal.
 *
 * The six statuses render with the same column palette as the kanban
 * board (note = neutral, backlog = slate, todo = sky, doing = amber,
 * review = violet, done = emerald) so the user's eye can link the pill
 * to the column it represents without reading the labels.
 */
export interface KanbanStatusControlProps {
  value: NoteStatus;
  onChange: (next: NoteStatus) => void;
  className?: string;
}

const LABELS: Record<NoteStatus, string> = {
  note: 'Note',
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'Doing',
  review: 'Review',
  done: 'Done',
};

/**
 * Color classes per status. Two shapes:
 *   - active (selected): solid-ish accent matching the column header
 *   - inactive: muted / transparent, gains a hint of the accent on hover
 *
 * Kept inline for clarity — this is the one spot in the UI that has to
 * enumerate all six, so a central map is fine.
 */
const STYLES: Record<NoteStatus, { active: string; inactive: string }> = {
  note: {
    active: 'bg-muted text-foreground ring-muted-foreground/30',
    inactive: 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
  },
  backlog: {
    active: 'bg-slate-500/20 text-slate-100 ring-slate-400/40',
    inactive: 'text-muted-foreground hover:bg-slate-500/10 hover:text-foreground',
  },
  todo: {
    active: 'bg-sky-500/20 text-sky-100 ring-sky-400/40',
    inactive: 'text-muted-foreground hover:bg-sky-500/10 hover:text-foreground',
  },
  doing: {
    active: 'bg-amber-500/20 text-amber-100 ring-amber-400/40',
    inactive: 'text-muted-foreground hover:bg-amber-500/10 hover:text-foreground',
  },
  review: {
    active: 'bg-violet-500/20 text-violet-100 ring-violet-400/40',
    inactive: 'text-muted-foreground hover:bg-violet-500/10 hover:text-foreground',
  },
  done: {
    active: 'bg-emerald-500/20 text-emerald-100 ring-emerald-400/40',
    inactive: 'text-muted-foreground hover:bg-emerald-500/10 hover:text-foreground',
  },
};

export function KanbanStatusControl({ value, onChange, className }: KanbanStatusControlProps) {
  return (
    <div
      role="group"
      aria-label="Card status"
      className={cn('inline-flex min-w-0 flex-wrap items-center gap-1', className)}
    >
      <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Status
      </span>
      {NOTE_STATUSES.map((s) => {
        const isActive = value === s;
        const style = STYLES[s];
        return (
          <button
            key={s}
            type="button"
            aria-pressed={isActive}
            onClick={() => {
              if (!isActive) onChange(s);
            }}
            title={
              isActive
                ? `Currently in ${LABELS[s]}`
                : `Move to ${LABELS[s]}`
            }
            className={cn(
              'inline-flex h-6 items-center rounded-full px-2.5 text-[11px] font-medium transition-colors ring-1',
              isActive ? style.active : cn('ring-transparent', style.inactive),
            )}
          >
            {LABELS[s]}
          </button>
        );
      })}
    </div>
  );
}
