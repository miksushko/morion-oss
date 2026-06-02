import { type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MessageCircle } from 'lucide-react';
import type { AutoCodeQueueRow, Note } from '../../lib/api';
import { TagChip } from '../../components/TagChip';
import { AutoCodeBadge } from '../../components/AutoCodeBadge';
import { cn } from '../../lib/cn';
import { deriveTitleFromBody } from '../../lib/deriveTitle';

export function SortableCard({
  note,
  onOpen,
  onContextMenu,
  selectMode,
  selected,
  onToggleSelect,
  tagColorByName,
  autoCodeRow,
  folderAutoCodeEnabled,
  onOpenAutoCode,
}: {
  note: Note;
  onOpen: () => void;
  onContextMenu: (x: number, y: number) => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  tagColorByName: Map<string, string | null>;
  autoCodeRow: AutoCodeQueueRow | null;
  folderAutoCodeEnabled: boolean;
  onOpenAutoCode: (taskId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: note.id,
      // Drag is disabled in select mode — the card's click semantics
      // change to "toggle selection" and dnd-kit sensors would otherwise
      // still fire on 6px drift, starting a ghost drag that can't resolve.
      disabled: selectMode,
    });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };
  const handleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    if (selectMode) {
      onToggleSelect();
      return;
    }
    onOpen();
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(selectMode ? {} : attributes)}
      {...(selectMode ? {} : listeners)}
      onClick={handleClick}
      onContextMenu={(e) => {
        // Suppress the native OS menu and hand off the viewport coords
        // to the KanbanView's state — same pattern as NotesList rows.
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e.clientX, e.clientY);
      }}
      className={cn(
        'group relative rounded-md border bg-card px-3 py-2 text-xs shadow-sm',
        selectMode
          ? selected
            ? 'cursor-pointer border-primary ring-1 ring-primary/60'
            : 'cursor-pointer border-border/60 hover:border-primary/50'
          : 'cursor-pointer border-border/60 hover:border-ring hover:bg-accent/40',
        selectMode && 'pl-9',
      )}
      aria-pressed={selectMode ? selected : undefined}
    >
      {selectMode && (
        <span
          className={cn(
            'pointer-events-none absolute left-2 top-2 flex h-4 w-4 items-center justify-center rounded border',
            selected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-background',
          )}
          aria-hidden
        >
          {selected && (
            <svg
              viewBox="0 0 12 12"
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="2.5 6.5 5 9 9.5 3.5" />
            </svg>
          )}
        </span>
      )}
      <KanbanCardBody
        note={note}
        tagColorByName={tagColorByName}
        autoCodeRow={autoCodeRow}
        folderAutoCodeEnabled={folderAutoCodeEnabled}
        onOpenAutoCode={onOpenAutoCode}
      />
    </div>
  );
}

export function KanbanCardPreview({
  note,
  tagColorByName,
  autoCodeRow,
  folderAutoCodeEnabled,
}: {
  note: Note;
  tagColorByName: Map<string, string | null>;
  autoCodeRow: AutoCodeQueueRow | null;
  folderAutoCodeEnabled?: boolean;
}) {
  return (
    <div className="pointer-events-none w-72 rounded-md border border-ring bg-card px-3 py-2 text-xs shadow-xl ring-1 ring-ring/40">
      <KanbanCardBody
        note={note}
        tagColorByName={tagColorByName}
        autoCodeRow={autoCodeRow}
        folderAutoCodeEnabled={folderAutoCodeEnabled ?? false}
        onOpenAutoCode={() => {}}
      />
    </div>
  );
}

function KanbanCardBody({
  note,
  tagColorByName,
  autoCodeRow,
  folderAutoCodeEnabled,
  onOpenAutoCode,
}: {
  note: Note;
  tagColorByName: Map<string, string | null>;
  autoCodeRow: AutoCodeQueueRow | null;
  folderAutoCodeEnabled: boolean;
  onOpenAutoCode: (taskId: string) => void;
}) {
  // Title from body. Apple-Notes-parity — server also does this, we
  // derive client-side as a fallback for unsaved optimistic cards.
  const title = note.title || deriveTitleFromBody(note.body) || 'Untitled';
  const preview = (note.body ?? '')
    .split('\n')
    .slice(1)
    .join(' ')
    .replace(/[#*>`]/g, '')
    .trim()
    .slice(0, 140);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn(
            'min-w-0 truncate font-medium text-foreground',
            note.archivedAt != null && 'italic text-muted-foreground',
          )}
        >
          {title}
        </span>
        {note.archivedAt != null && (
          <span
            className="shrink-0 rounded bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
            title="Archived — hidden from MCP"
          >
            Archived
          </span>
        )}
        <AutoCodeBadge
          row={autoCodeRow}
          taskId={note.id}
          folderAutoCodeEnabled={folderAutoCodeEnabled}
          onClick={onOpenAutoCode}
        />
      </div>
      {preview && (
        <span className="line-clamp-2 text-[11px] text-muted-foreground">{preview}</span>
      )}
      {note.tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {note.tags.slice(0, 3).map((t) => (
            <TagChip
              key={t}
              size="sm"
              tag={{ name: t, color: tagColorByName.get(t) ?? null }}
            />
          ))}
          {note.tags.length > 3 && (
            <span className="text-[10px] text-muted-foreground">
              +{note.tags.length - 3}
            </span>
          )}
        </div>
      )}
      {(note.commentCount ?? 0) > 0 && (
        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
          <MessageCircle className="h-3 w-3" />
          <span className="tabular-nums">{note.commentCount}</span>
        </div>
      )}
    </div>
  );
}
