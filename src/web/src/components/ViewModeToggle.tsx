import { LayoutGrid, List as ListIcon } from 'lucide-react';
import type { FolderViewMode } from '../lib/api';
import { cn } from '../lib/cn';

/**
 * Segmented button bar for switching a folder between list and kanban.
 *
 * Rendered inside the pane header (NotesList in list-mode, KanbanView in
 * kanban-mode). Shows both options at once with the current one
 * highlighted. Clicking the inactive option fires `onChange(mode)`;
 * clicking the active option is a no-op (no API round-trip for the
 * state you're already in).
 *
 * Parent owns the confirm dialog for kanban→list — this component is a
 * pure control. It doesn't know what's destructive, that's a tier-up
 * concern.
 */

export interface ViewModeToggleProps {
  value: FolderViewMode;
  onChange: (next: FolderViewMode) => void;
  /** Optional className for the outer container (e.g. for spacing). */
  className?: string;
  /** Icon-only compact variant. Used in the NotesList header where the
   * folder title is tight on horizontal space; the kanban header has
   * room for labels so stays verbose. */
  compact?: boolean;
}

export function ViewModeToggle({ value, onChange, className, compact = false }: ViewModeToggleProps) {
  return (
    <div
      role="group"
      aria-label="Folder view mode"
      className={cn(
        'inline-flex h-7 shrink-0 items-center rounded-md border border-border bg-background/60 p-0.5',
        className,
      )}
    >
      <ViewModeSegment
        icon={<ListIcon className="h-3.5 w-3.5" />}
        label="List"
        active={value === 'list'}
        compact={compact}
        onClick={() => {
          if (value !== 'list') onChange('list');
        }}
      />
      <ViewModeSegment
        icon={<LayoutGrid className="h-3.5 w-3.5" />}
        label="Kanban"
        active={value === 'kanban'}
        compact={compact}
        onClick={() => {
          if (value !== 'kanban') onChange('kanban');
        }}
      />
    </div>
  );
}

function ViewModeSegment({
  icon,
  label,
  active,
  compact,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  compact: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={active ? `Showing as ${label.toLowerCase()}` : `Switch to ${label.toLowerCase()}`}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-[4px] text-xs font-medium transition-colors',
        compact ? 'w-7 justify-center px-0' : 'px-2',
        active
          ? 'bg-accent text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {!compact && <span>{label}</span>}
    </button>
  );
}
