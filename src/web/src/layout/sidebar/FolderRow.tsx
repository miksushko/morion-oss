import { useRef } from 'react';
import {
  Folder as FolderIcon,
  GripVertical,
  LayoutGrid,
} from 'lucide-react';
import type { Folder } from '../../lib/api';
import { cn } from '../../lib/cn';
import { McpPermsStrip } from '../../components/McpPermsStrip';
import { FolderActionsMenu } from '../../components/FolderActionsMenu';
import { isFolderHiddenFromAI } from '../../lib/mcpRestricted';
import { FolderRenameInput } from './FolderRenameInput';

export interface FolderRowProps {
  folder: Folder;
  active: boolean;
  editing: boolean;
  isDropTarget: boolean;
  isFirst: boolean;
  isLast: boolean;
  reviewMcp?: boolean;
  onSelect: () => void;
  onStartRename: () => void;
  onSubmitRename: (name: string) => Promise<void> | void;
  onCancelRename: () => void;
  onDelete: () => Promise<void> | void;
  onDuplicate: () => void;
  onShareWithLLM: () => void;
  onOpenSettings: () => void;
  onSwitchViewMode: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onExport: () => void;
  onArchive?: () => Promise<void> | void;
  onUnarchive?: () => Promise<void> | void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

/** Single folder row in the sidebar — drag handle, name button (which
 *  doubles as the select + double-click-to-rename surface),
 *  FolderActionsMenu, and the note-count badge. Swaps in
 *  FolderRenameInput while the row is being renamed. */
export function FolderRow(props: FolderRowProps) {
  const {
    folder,
    active,
    editing,
    isDropTarget,
    isFirst,
    isLast,
    reviewMcp,
    onSelect,
    onStartRename,
    onSubmitRename,
    onCancelRename,
    onDelete,
    onDuplicate,
    onShareWithLLM,
    onOpenSettings,
    onSwitchViewMode,
    onMoveUp,
    onMoveDown,
    onExport,
    onArchive,
    onUnarchive,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd,
    onContextMenu,
  } = props;

  const rowRef = useRef<HTMLDivElement | null>(null);
  // The grip's onDragStart sets the OS drag preview to a snapshot of
  // the full row at the same cursor offset. Without this the preview
  // would be the bare 12px GripVertical span — invisible in practice
  // and the user loses the cue of WHAT they're dragging.
  const handleHandleDragStart = (e: React.DragEvent): void => {
    if (rowRef.current) {
      const rect = rowRef.current.getBoundingClientRect();
      e.dataTransfer.setDragImage(
        rowRef.current,
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
    }
    onDragStart(e);
  };

  return (
    <div
      ref={rowRef}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onContextMenu={onContextMenu}
      className={cn(
        'group relative flex min-w-0 select-none items-center gap-1 rounded-md pl-2 pr-3 transition-colors',
        active ? 'bg-accent' : 'hover:bg-accent/60',
        isDropTarget && 'bg-accent/40 ring-2 ring-ring',
      )}
    >
      {editing ? (
        <FolderRenameInput
          initial={folder.name}
          onSubmit={onSubmitRename}
          onCancel={onCancelRename}
        />
      ) : (
        <>
          {/* Drag handle is the ONLY draggable element on the row. The
              previous "outer div is draggable" pattern lost the
              drag-vs-click arbitration in WKWebView whenever the user
              grabbed the inner <button> (folder-name area), which
              dominates the row width — drag never initiated despite
              setData + select-none. Confining `draggable` to a tight
              span around GripVertical eliminates the arbitration and
              matches the macOS sidebar convention (drag = grab the
              handle, click = anywhere else). The row itself remains
              a drop target. */}
          <span
            draggable={!editing}
            onDragStart={handleHandleDragStart}
            onDragEnd={onDragEnd}
            role="presentation"
            aria-hidden="true"
            className="flex shrink-0 cursor-grab items-center"
          >
            <GripVertical
              strokeWidth={1.5}
              className="h-3 w-3 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground/80"
            />
          </span>
          <button
            type="button"
            onClick={onSelect}
            onDoubleClick={onStartRename}
            title={folder.name}
            className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-foreground"
          >
            {folder.viewMode === 'kanban' ? (
              <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <FolderIcon className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span
                className={cn(
                  'min-w-0 truncate',
                  folder.archivedAt != null && 'text-muted-foreground italic',
                )}
              >
                {folder.name}
              </span>
              {folder.archivedAt != null && (
                <span
                  className="shrink-0 rounded bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
                  title="Archived — hidden from MCP"
                >
                  Archived
                </span>
              )}
              {reviewMcp ? (
                <McpPermsStrip
                  entries={[
                    { letter: 'V', label: 'View', allowed: folder.mcpPermissions.visible },
                    { letter: 'C', label: 'Create', allowed: folder.mcpPermissions.create },
                    { letter: 'E', label: 'Edit', allowed: folder.mcpPermissions.update },
                    { letter: 'D', label: 'Delete', allowed: folder.mcpPermissions.delete },
                  ]}
                />
              ) : (
                isFolderHiddenFromAI(folder) && (
                  <span
                    className="shrink-0 text-[11px] text-muted-foreground/60 line-through"
                    title="AI can't see this folder"
                    aria-label="AI can't see this folder"
                  >
                    AI
                  </span>
                )
              )}
            </span>
          </button>
          <FolderActionsMenu
            folderName={folder.name}
            viewMode={folder.viewMode}
            canMoveUp={!isFirst}
            canMoveDown={!isLast}
            isArchived={folder.archivedAt != null}
            onRename={onStartRename}
            onDuplicate={onDuplicate}
            onShareWithLLM={onShareWithLLM}
            onOpenSettings={onOpenSettings}
            onSwitchViewMode={onSwitchViewMode}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            onExport={onExport}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
            onDelete={onDelete}
          />
          {folder.noteCount > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {folder.noteCount}
            </span>
          )}
        </>
      )}
    </div>
  );
}
