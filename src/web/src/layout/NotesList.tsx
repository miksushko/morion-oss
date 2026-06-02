import { Fragment, useMemo, useState } from 'react';
import {
  ChevronLeft,
  LayoutGrid,
  Plus,
  Share2,
  Trash,
} from 'lucide-react';
import type { Folder } from '../lib/api';
import { FolderActionsMenu } from '../components/FolderActionsMenu';
import { NotesActionButton } from './notes-list/NotesActionButton';
import { NoteRow } from './notes-list/NoteRow';
import {
  NoteContextMenu,
  type NoteContextMenuState,
} from './notes-list/NoteContextMenu';
import { groupNotesByDate } from './notes-list/group';
import type { NotesListProps } from './notes-list/types';

export { NOTE_DRAG_MIME } from './notes-list/NoteRow';
export type { NotesListProps } from './notes-list/types';

/**
 * Notes list pane (middle of the three-pane layout, or full-width in
 * Trash). Composition shell — every visible block lives under
 * `./notes-list/` (`NoteRow`, `TagDotsRow`, `NotesActionButton`,
 * `NoteContextMenu`) and pure helpers (`groupNotesByDate`, `previewFor`,
 * `formatUpdated`) are pinned by `tests/notes-list-format.test.ts`
 * + `tests/notes-list-group.test.ts`.
 *
 * Notes-list redesign 2026-05-06 (ticket `01KQXZJX3KSY32B7J9HZNGZ9T2`):
 * mirror the Mo Chat sidebar layout. Three-row header instead of one
 * cramped row — identity strip (h-52) / action buttons / list body.
 */
export function NotesList({
  notes,
  folders,
  allTags,
  showFolderBadges,
  folderTitle,
  folder,
  onOpenFolderSettings,
  onRenameFolder,
  onDuplicateFolder,
  onExportFolder,
  onMoveFolder,
  onArchiveFolder,
  onUnarchiveFolder,
  onDeleteFolder,
  folderCanMoveUp,
  folderCanMoveDown,
  selectedId,
  onSelect,
  onNewNote,
  onMobileBack,
  loadedCount,
  totalCount,
  onLoadMore,
  onShareFolderWithLLM,
  onChangeFolderViewMode,
  onShareNoteWithLLM,
  onCopyNoteBody,
  onDuplicateNote,
  onMoveNoteToFolder,
  onDeleteNote,
  onArchiveNote,
  onUnarchiveNote,
  onOpenNoteAIAccess,
  trashMode = false,
  onEmptyTrash,
  reviewMcp,
}: NotesListProps) {
  const hasMore = loadedCount < totalCount;
  // Right-click context menu state. `view` toggles between the main action
  // list and the "Move to..." folder picker — both anchored to the same
  // (clientX, clientY) so they replace each other in place.
  const [contextMenu, setContextMenu] = useState<NoteContextMenuState | null>(
    null,
  );

  // Look up the right-clicked note fresh on every render so the menu stays
  // honest if the underlying note changes (rename, move, delete) while open.
  const contextNote = contextMenu
    ? notes.find((n) => n.id === contextMenu.noteId) ?? null
    : null;

  const handleScroll = (e: React.UIEvent<HTMLUListElement>) => {
    if (!hasMore) return;
    const el = e.currentTarget;
    // Trigger when the viewport gets within one screen-height of the bottom.
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - el.clientHeight) {
      onLoadMore();
    }
  };

  // Cheap lookup so the badge can name the folder without an extra fetch.
  const folderById = useMemo(() => {
    const m = new Map<string, Folder>();
    for (const f of folders) m.set(f.id, f);
    return m;
  }, [folders]);

  // Name → color lookup for the tag dots row. A note stores tag names; the
  // catalogue owns the colors. Missing colors fall back to a muted border-only
  // dot so they're still visible without shouting.
  const tagColorByName = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const t of allTags) m.set(t.name, t.color);
    return m;
  }, [allTags]);

  const groups = useMemo(
    () => groupNotesByDate(notes, trashMode ? 'deletedAt' : 'updatedAt'),
    [notes, trashMode],
  );

  const onCardContextMenu = trashMode
    ? null
    : (noteId: string, x: number, y: number) =>
        setContextMenu({ noteId, x, y, view: 'main' });

  return (
    <div className="flex h-full w-full flex-col border-r border-border bg-muted/40 md:w-72">
      {/* Identity strip (h-52) — same baseline as folder-sidebar logo +
          Mo sidebar identity strip so all three panel tops align. */}
      <div className="flex h-[52px] shrink-0 items-center gap-2 px-3 pt-1.5">
        <button
          type="button"
          onClick={onMobileBack}
          aria-label="Back to folders"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <h2
          className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground"
          title={folderTitle}
        >
          {folderTitle}
        </h2>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {hasMore ? `${notes.length} / ${totalCount}` : notes.length}
        </span>
        {/* Full folder more-menu — same dropdown as the folder-tree row
            right-click but always visible. Hidden in All-notes view +
            Trash (no concrete folder to operate on) and when the parent
            didn't wire the callbacks. */}
        {!trashMode && folder && onOpenFolderSettings && onRenameFolder &&
         onDuplicateFolder && onExportFolder && onMoveFolder &&
         onDeleteFolder && onShareFolderWithLLM && onChangeFolderViewMode && (
          <span className="ml-auto">
            <FolderActionsMenu
              folderName={folder.name}
              viewMode={folder.viewMode ?? 'list'}
              canMoveUp={folderCanMoveUp ?? true}
              canMoveDown={folderCanMoveDown ?? true}
              isArchived={folder.archivedAt != null}
              onRename={() => onRenameFolder(folder)}
              onDuplicate={() => onDuplicateFolder(folder)}
              onShareWithLLM={() => void onShareFolderWithLLM()}
              onOpenSettings={() => onOpenFolderSettings(folder)}
              onSwitchViewMode={() =>
                void onChangeFolderViewMode(
                  folder.viewMode === 'kanban' ? 'list' : 'kanban',
                )
              }
              onMoveUp={() => onMoveFolder(folder, 'up')}
              onMoveDown={() => onMoveFolder(folder, 'down')}
              onExport={() => onExportFolder(folder)}
              onArchive={onArchiveFolder ? () => onArchiveFolder(folder) : undefined}
              onUnarchive={onUnarchiveFolder ? () => onUnarchiveFolder(folder) : undefined}
              onDelete={() => onDeleteFolder(folder)}
              triggerClassName="inline-flex h-7 w-7 items-center justify-center"
            />
          </span>
        )}
      </div>

      {!trashMode && (
        <div className="shrink-0 px-2 pt-1 pb-2">
          <NotesActionButton
            icon={<Plus className="h-3.5 w-3.5" />}
            label="New note"
            shortcut="⌘N"
            onClick={onNewNote}
          />
          {onShareFolderWithLLM && (
            <NotesActionButton
              icon={<Share2 className="h-3.5 w-3.5" />}
              label="Share Folder with LLM"
              onClick={() => void onShareFolderWithLLM()}
            />
          )}
          {onChangeFolderViewMode && (
            <NotesActionButton
              icon={<LayoutGrid className="h-3.5 w-3.5" />}
              label="Switch to Kanban"
              onClick={() => void onChangeFolderViewMode('kanban')}
            />
          )}
        </div>
      )}

      {trashMode && onEmptyTrash && notes.length > 0 && (
        <div className="shrink-0 px-2 pt-1 pb-2">
          <button
            type="button"
            onClick={() => void onEmptyTrash()}
            aria-label="Empty trash"
            title="Permanently delete every note in the trash"
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span className="inline-flex w-4 shrink-0 items-center justify-center">
              <Trash className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate">Empty Trash</span>
          </button>
        </div>
      )}

      <ul className="flex-1 overflow-y-auto px-1 pb-2" onScroll={handleScroll}>
        {notes.length === 0 && (
          <li className="px-3 py-6 text-sm text-muted-foreground">
            {trashMode ? (
              <>Trash is empty. Notes you delete will appear here for 7 days before they are permanently removed.</>
            ) : (
              <>
                No notes yet. Hit <kbd className="rounded border border-border bg-muted px-1 font-mono text-xs">⌘N</kbd> to start.
              </>
            )}
          </li>
        )}
        {groups.map((group) => (
          <Fragment key={group.label}>
            {group.label !== 'Pinned' && (
              <li
                className="sticky top-0 z-10 bg-muted/40 px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur-sm"
                aria-label={`${group.label} section`}
              >
                {group.label}
              </li>
            )}
            {group.notes.map((n) => (
              <NoteRow
                key={n.id}
                note={n}
                folder={n.folderId ? folderById.get(n.folderId) ?? null : null}
                active={selectedId === n.id}
                trashMode={trashMode}
                showFolderBadges={showFolderBadges}
                reviewMcp={reviewMcp ?? false}
                tagColorByName={tagColorByName}
                onSelect={onSelect}
                onContextMenu={onCardContextMenu}
              />
            ))}
          </Fragment>
        ))}
      </ul>

      {contextMenu && contextNote && (
        <NoteContextMenu
          state={contextMenu}
          contextNote={contextNote}
          notes={notes}
          folders={folders}
          onClose={() => setContextMenu(null)}
          onSetView={(view) => setContextMenu({ ...contextMenu, view })}
          onShareNoteWithLLM={onShareNoteWithLLM}
          onCopyNoteBody={onCopyNoteBody}
          onDuplicateNote={onDuplicateNote}
          onMoveNoteToFolder={onMoveNoteToFolder}
          onDeleteNote={onDeleteNote}
          onArchiveNote={onArchiveNote}
          onUnarchiveNote={onUnarchiveNote}
          onOpenNoteAIAccess={onOpenNoteAIAccess}
        />
      )}
    </div>
  );
}
