import { ChevronUp, ChevronDown } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Up/down icon buttons for walking through kanban cards without closing
 * the modal. ClickUp-style.
 *
 * Semantics (match `kanbanCardNeighbours` in `lib/kanbanOrder.ts`):
 *   - Up moves to the previous card in column order; crosses column
 *     boundaries into the last card of the preceding column.
 *   - Down moves to the next card; crosses column boundaries into the
 *     first card of the following column.
 *   - At the first card of `note` (top-left of the board) the Up button
 *     is disabled.
 *   - At the last card of `done` (bottom-right) the Down button is
 *     disabled.
 *
 * Parent (App.tsx) owns the flat ordered list and just passes
 * `prevId` / `nextId` — null for the absolute-end cases. That keeps the
 * navigator stateless and lets the same `handleOpenKanbanCard` callback
 * the modal already uses handle the actual swap.
 */
export interface KanbanCardNavigatorProps {
  prevId: string | null;
  nextId: string | null;
  onNavigate: (noteId: string) => void;
  className?: string;
}

export function KanbanCardNavigator({
  prevId,
  nextId,
  onNavigate,
  className,
}: KanbanCardNavigatorProps) {
  return (
    <div
      role="group"
      aria-label="Navigate between cards"
      className={cn('inline-flex shrink-0 items-center gap-0.5', className)}
    >
      <button
        type="button"
        disabled={prevId === null}
        onClick={() => {
          if (prevId !== null) onNavigate(prevId);
        }}
        title="Previous card (up)"
        aria-label="Previous card"
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors',
          prevId === null
            ? 'cursor-not-allowed opacity-30'
            : 'hover:bg-accent hover:text-foreground',
        )}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        disabled={nextId === null}
        onClick={() => {
          if (nextId !== null) onNavigate(nextId);
        }}
        title="Next card (down)"
        aria-label="Next card"
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors',
          nextId === null
            ? 'cursor-not-allowed opacity-30'
            : 'hover:bg-accent hover:text-foreground',
        )}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
