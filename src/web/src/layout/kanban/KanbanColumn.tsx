import { useMemo } from 'react';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { ChevronLeft, Plus } from 'lucide-react';
import type { AutoCodeQueueRow, Note, NoteStatus } from '../../lib/api';
import { cn } from '../../lib/cn';
import { SortableCard } from './KanbanCard';

export interface KanbanColumnProps {
  status: NoteStatus;
  label: string;
  description: string;
  accent: string;
  cards: Note[];
  onOpenCard: (noteId: string) => void;
  onAddCard: () => void;
  onCollapseColumn: () => void;
  /** Right-click on a card bubbles viewport coordinates up to the
   * KanbanView, which owns the menu state. Column doesn't render the
   * menu itself so a single instance can float over the whole board. */
  onCardContextMenu: (noteId: string, x: number, y: number) => void;
  selectMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (noteId: string) => void;
  tagColorByName: Map<string, string | null>;
  /** Latest auto-code queue row per task id — passed through from
   *  the KanbanView batch fetch so cards don't N+1. Undefined for
   *  tasks with no auto-code activity (badge stays hidden). */
  autoCodeRows: Map<string, AutoCodeQueueRow>;
  /** True when the folder has auto-code enabled. Drives the badge's
   *  "configure" affordance on tickets without a queue row (ticket
   *  01KRWQPDKQ2RZMDBJZ5KN0B7YE). */
  folderAutoCodeEnabled: boolean;
  onOpenAutoCode: (taskId: string) => void;
}

export function KanbanColumn(props: KanbanColumnProps) {
  const {
    status,
    label,
    description,
    accent,
    cards,
    onOpenCard,
    onAddCard,
    onCollapseColumn,
    onCardContextMenu,
    selectMode,
    selectedIds,
    onToggleSelect,
    tagColorByName,
    autoCodeRows,
    folderAutoCodeEnabled,
    onOpenAutoCode,
  } = props;
  const cardIds = useMemo(() => cards.map((c) => c.id), [cards]);

  return (
    <div
      className="flex h-full min-h-0 w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-card/30"
      data-kanban-column={status}
    >
      <button
        type="button"
        onClick={onCollapseColumn}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-t-lg px-3 py-2 text-left transition-colors hover:brightness-110',
          accent,
        )}
        title={`Collapse the ${label} column`}
        aria-label={`Collapse the ${label} column`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-foreground/90">
            {label}
          </span>
          <span className="rounded bg-background/50 px-1.5 text-[10px] font-medium text-muted-foreground">
            {cards.length}
          </span>
        </div>
        <ChevronLeft className="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>
      <div className="px-2 py-1 text-[10px] text-muted-foreground">{description}</div>
      <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
        <ColumnDroppable
          status={status}
          cards={cards}
          label={label}
          onOpenCard={onOpenCard}
          onAddCard={onAddCard}
          onCardContextMenu={onCardContextMenu}
          selectMode={selectMode}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          tagColorByName={tagColorByName}
          autoCodeRows={autoCodeRows}
          folderAutoCodeEnabled={folderAutoCodeEnabled}
          onOpenAutoCode={onOpenAutoCode}
        />
      </SortableContext>
    </div>
  );
}

/**
 * Inner column area that hosts both the sortable card list AND the
 * "empty column" drop target (the pseudo-id "col:<status>"). Without a
 * dedicated empty-area droppable, dragging into an empty column is a
 * no-op because dnd-kit needs an over.id to fire.
 */
function ColumnDroppable({
  status,
  cards,
  label,
  onOpenCard,
  onAddCard,
  onCardContextMenu,
  selectMode,
  selectedIds,
  onToggleSelect,
  tagColorByName,
  autoCodeRows,
  folderAutoCodeEnabled,
  onOpenAutoCode,
}: {
  status: NoteStatus;
  cards: Note[];
  label: string;
  onOpenCard: (noteId: string) => void;
  onAddCard: () => void;
  onCardContextMenu: (noteId: string, x: number, y: number) => void;
  selectMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (noteId: string) => void;
  tagColorByName: Map<string, string | null>;
  autoCodeRows: Map<string, AutoCodeQueueRow>;
  folderAutoCodeEnabled: boolean;
  onOpenAutoCode: (taskId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}` });
  // In the `note` column the label "task" feels wrong — they're notes,
  // not tasks. Lexical tweak matches the mental model.
  const verb = status === 'note' ? 'Add note' : 'Add task';
  return (
    <div
      ref={setNodeRef}
      className={cn(
        // Per-column vertical scroll. `flex-1 min-h-0` lets the droppable
        // occupy the remaining column height (header + description are
        // fixed-size siblings); `overflow-y-auto` turns it into the single
        // scroll layer for the card list so long boards don't overflow the
        // column's rounded border (bug 01KPGDVFS3E7A60R951EX4V5MQ).
        'flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2 pt-1',
        isOver && 'rounded-b-lg bg-accent/40',
      )}
    >
      {cards.length === 0 ? (
        <div className="rounded border border-dashed border-border/60 p-3 text-center text-[11px] text-muted-foreground/70">
          Drop cards here
        </div>
      ) : (
        cards.map((c) => (
          <SortableCard
            key={c.id}
            note={c}
            onOpen={() => onOpenCard(c.id)}
            onContextMenu={(x, y) => onCardContextMenu(c.id, x, y)}
            selectMode={selectMode}
            selected={selectedIds.has(c.id)}
            onToggleSelect={() => onToggleSelect(c.id)}
            tagColorByName={tagColorByName}
            autoCodeRow={autoCodeRows.get(c.id) ?? null}
            folderAutoCodeEnabled={folderAutoCodeEnabled}
            onOpenAutoCode={onOpenAutoCode}
          />
        ))
      )}
      <button
        type="button"
        onClick={onAddCard}
        className="mt-1 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        title={`${verb} in ${label}`}
      >
        <Plus className="h-3 w-3" />
        {verb}
      </button>
    </div>
  );
}
