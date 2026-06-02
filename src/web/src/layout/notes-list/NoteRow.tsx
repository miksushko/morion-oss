import type { Folder, Note } from '../../lib/api';
import { Folder as FolderIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { McpPermsStrip } from '../../components/McpPermsStrip';
import { effectiveNotePerms, isNoteHiddenFromAI } from '../../lib/mcpRestricted';
import { TagDotsRow } from './TagDotsRow';
import { formatUpdated, previewFor } from './format';

export const NOTE_DRAG_MIME = 'application/x-morion-note';

export interface NoteRowProps {
  note: Note;
  folder: Folder | null;
  active: boolean;
  trashMode: boolean;
  showFolderBadges: boolean;
  reviewMcp: boolean;
  tagColorByName: Map<string, string | null>;
  onSelect: (id: string) => void;
  /** Right-click viewport coords. Trash mode passes `null` because the
   *  parent suppresses context menus there. */
  onContextMenu: ((noteId: string, x: number, y: number) => void) | null;
}

/**
 * Single row in the NotesList. Owns the drag-start payload (Sidebar
 * sniffs `NOTE_DRAG_MIME` to distinguish a note drag from a folder
 * reorder), the click-to-select behaviour, and the per-row metadata
 * stack (title + archive chip + AI-hidden / MCP-perms indicator +
 * preview snippet + relative-time + folder badge + tag dots).
 *
 * State-free — pure render. The parent shell owns `selectedId`,
 * `contextMenu`, drag-target highlighting (none in this list — drag
 * targets live on the Sidebar / Kanban columns).
 */
export function NoteRow({
  note,
  folder,
  active,
  trashMode,
  showFolderBadges,
  reviewMcp,
  tagColorByName,
  onSelect,
  onContextMenu,
}: NoteRowProps) {
  return (
    <li>
      <button
        type="button"
        draggable={!trashMode}
        onDragStart={(e) => {
          if (trashMode) return;
          e.dataTransfer.setData(NOTE_DRAG_MIME, note.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onClick={() => onSelect(note.id)}
        onContextMenu={(e) => {
          if (trashMode) {
            e.preventDefault();
            onSelect(note.id);
            return;
          }
          e.preventDefault();
          onSelect(note.id);
          onContextMenu?.(note.id, e.clientX, e.clientY);
        }}
        className={cn(
          'w-full rounded-md px-3 py-2 text-left transition-colors',
          active ? 'bg-accent' : 'hover:bg-accent/60',
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
          <span
            className={cn(
              'min-w-0 truncate',
              note.archivedAt != null && 'text-muted-foreground italic',
            )}
          >
            {note.title || 'Untitled'}
          </span>
          {note.archivedAt != null && (
            <span
              className="shrink-0 rounded bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
              title="Archived — hidden from MCP"
            >
              Archived
            </span>
          )}
          {reviewMcp ? (
            <McpPermsStrip
              entries={(() => {
                const eff = effectiveNotePerms(note, folder);
                const p = note.mcpPermissions;
                return [
                  { letter: 'V', label: 'View', allowed: eff.visible, pinned: p.visible !== null },
                  { letter: 'E', label: 'Edit', allowed: eff.update, pinned: p.update !== null },
                  { letter: 'D', label: 'Delete', allowed: eff.delete, pinned: p.delete !== null },
                ];
              })()}
            />
          ) : (
            isNoteHiddenFromAI(note, folder) && (
              <span
                className="shrink-0 text-[11px] font-normal text-muted-foreground/60 line-through"
                title="AI can't see this note"
                aria-label="AI can't see this note"
              >
                AI
              </span>
            )
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {previewFor(note.body) || 'No additional text'}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground/70">
          <span className="shrink-0">
            {trashMode && note.deletedAt
              ? `Deleted ${formatUpdated(note.deletedAt)}`
              : formatUpdated(note.updatedAt)}
          </span>
          {showFolderBadges && folder && (
            <span
              title={folder.name}
              className="inline-flex min-w-0 items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 normal-case tracking-normal text-muted-foreground"
            >
              <FolderIcon className="h-2.5 w-2.5 shrink-0" />
              <span className="min-w-0 truncate">{folder.name}</span>
            </span>
          )}
          {note.tags.length > 0 && (
            <span className="ml-auto shrink-0">
              <TagDotsRow tags={note.tags} colorByName={tagColorByName} />
            </span>
          )}
        </div>
      </button>
    </li>
  );
}
