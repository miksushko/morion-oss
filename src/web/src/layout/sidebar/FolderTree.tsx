import { Plus } from 'lucide-react';
import type { Folder, FolderViewMode } from '../../lib/api';
import type { FolderSettingsTab } from '../../components/FolderSettingsDialog';
import { exportFolderAsMarkdownZip } from '../../lib/exportFolder';
import { useConfirm } from '../../components/ConfirmDialog';
import { NOTE_DRAG_MIME } from '../NotesList';
import { applyFolderDragStart, FOLDER_DRAG_MIME } from './folder-drag';
import { computeReorderedFolderIds } from './drag-reorder';
import { FolderRow } from './FolderRow';
import { FolderCreateInput } from './FolderCreateInput';
import type { FolderContextState } from './FolderContextMenu';

/**
 * Folder list section of the sidebar — splits `folders` into list /
 * kanban groups by `viewMode`, renders each group with its own header
 * + "+ New" button + inline create input, and wires every FolderRow
 * with its full callback bundle (rename / delete / duplicate / share /
 * settings / view-mode toggle / move / export / archive / drag-drop /
 * context-menu trigger).
 *
 * Owns its own delete + archive confirm dialogs via `useConfirm`.
 * State that needs to leak back to the parent shell (active rename id,
 * folder-context-menu trigger, drag/drop highlight) flows through the
 * `state` + `setState` props.
 */
export function FolderTree({
  folders,
  view,
  selectedFolderId,
  reviewMcp,
  editingId,
  setEditingId,
  draggedFolderId,
  setDraggedFolderId,
  dropTarget,
  setDropTarget,
  setFolderContext,
  creating,
  setCreating,
  creatingKanban,
  setCreatingKanban,
  onSelectFolder,
  onCreateFolder,
  onCreateKanbanFolder,
  onRenameFolder,
  onDeleteFolder,
  onDuplicateFolder,
  onMoveFolder,
  onReorderFolders,
  onMoveNoteToFolder,
  onShareFolderWithLLM,
  onOpenFolderSettings,
  onChangeFolderViewMode,
  onArchiveFolder,
  onUnarchiveFolder,
}: {
  folders: Folder[];
  view: string;
  selectedFolderId: string | undefined;
  reviewMcp?: boolean;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  draggedFolderId: string | null;
  setDraggedFolderId: (id: string | null) => void;
  dropTarget: string | null;
  setDropTarget: (id: string | null) => void;
  setFolderContext: (state: FolderContextState | null) => void;
  creating: boolean;
  setCreating: (next: boolean) => void;
  creatingKanban: boolean;
  setCreatingKanban: (next: boolean) => void;
  onSelectFolder: (folderId: string | undefined) => void;
  onCreateFolder: (name: string) => Promise<void> | void;
  onCreateKanbanFolder: (name: string) => Promise<void> | void;
  onRenameFolder: (id: string, name: string) => Promise<void> | void;
  onDeleteFolder: (
    id: string,
    opts?: { purgeNotes?: boolean },
  ) => Promise<void> | void;
  onDuplicateFolder: (id: string) => Promise<void> | void;
  onMoveFolder: (id: string, direction: 'up' | 'down') => Promise<void> | void;
  onReorderFolders: (orderedIds: string[]) => Promise<void> | void;
  onMoveNoteToFolder: (
    noteId: string,
    targetFolderId: string | null,
  ) => Promise<void> | void;
  onShareFolderWithLLM: (id: string) => Promise<void> | void;
  onOpenFolderSettings: (folder: Folder, tab?: FolderSettingsTab) => void;
  onChangeFolderViewMode: (
    folder: Folder,
    mode: FolderViewMode,
  ) => Promise<void> | void;
  onArchiveFolder?: (id: string) => Promise<void> | void;
  onUnarchiveFolder?: (id: string) => Promise<void> | void;
}) {
  const confirm = useConfirm();

  const isNoteDrag = (e: React.DragEvent): boolean =>
    e.dataTransfer.types.includes(NOTE_DRAG_MIME);

  // Folder-drag detection MUST read from dataTransfer, not React state.
  // The `draggedFolderId` useState below is set in onDragStart, but in
  // WKWebView (Tauri prod desktop) the dragover/drop events on the
  // target can fire BEFORE React commits the setDraggedFolderId update —
  // so reading the state inside the dragover predicate returns null,
  // `e.preventDefault()` is skipped, and the OS never delivers the drop
  // event. Chromium gives React enough time between dragstart and the
  // first dragover that this rarely loses; WKWebView's faster scheduling
  // makes it reproducibly silent. Reading from dataTransfer.types is
  // safe on every event (only `getData` is gated to drop). React state
  // stays as a visual-cue source only.
  const isFolderDrag = (e: React.DragEvent): boolean =>
    e.dataTransfer.types.includes(FOLDER_DRAG_MIME);

  // Direction N: split into two groups by view_mode. List folders come
  // first (the default) and kanban folders follow under a dedicated
  // header. Positions come from the server (same reorder call), so
  // indices reflect the combined ordering — the `isFirst` / `isLast`
  // flags on the context menu use the group-local boundaries.
  const listFolders = folders.filter((f) => f.viewMode === 'list');
  const kanbanFolders = folders.filter((f) => f.viewMode === 'kanban');

  const handleFolderDrop = (targetId: string, e: React.DragEvent) => {
    if (isNoteDrag(e)) {
      const noteId = e.dataTransfer.getData(NOTE_DRAG_MIME);
      setDropTarget(null);
      if (noteId) void onMoveNoteToFolder(noteId, targetId);
      return;
    }
    // Source id MUST come from dataTransfer, not the React
    // draggedFolderId state — see isFolderDrag comment above for the
    // WKWebView state-lag race that made prod drop silently no-op.
    const sourceId = e.dataTransfer.getData(FOLDER_DRAG_MIME);
    setDraggedFolderId(null);
    setDropTarget(null);
    if (!sourceId) return;
    const next = computeReorderedFolderIds(folders, sourceId, targetId);
    if (next) void onReorderFolders(next);
  };

  const renderRow = (f: Folder, groupIndex: number, groupLength: number) => (
    <FolderRow
      key={f.id}
      folder={f}
      reviewMcp={reviewMcp}
      active={view === 'notes' && selectedFolderId === f.id}
      editing={editingId === f.id}
      isDropTarget={dropTarget === f.id && draggedFolderId !== f.id}
      isFirst={groupIndex === 0}
      isLast={groupIndex === groupLength - 1}
      onSelect={() => onSelectFolder(f.id)}
      onStartRename={() => setEditingId(f.id)}
      onSubmitRename={async (name) => {
        setEditingId(null);
        if (name && name !== f.name) await onRenameFolder(f.id, name);
      }}
      onCancelRename={() => setEditingId(null)}
      onDelete={async () => {
        const noteWord =
          f.noteCount === 1 ? 'note inside' : `notes inside (${f.noteCount})`;
        if (f.noteCount > 0) {
          const result = await confirm({
            title: `Delete folder "${f.name}"?`,
            description:
              'By default, notes inside survive — they become unfiled and stay in the workspace.',
            confirmLabel: 'Delete folder',
            destructive: true,
            checkbox: { label: `Also move ${noteWord} to Trash` },
          });
          if (result.confirmed)
            await onDeleteFolder(f.id, { purgeNotes: result.checkboxChecked });
        } else {
          const ok = await confirm({
            title: `Delete folder "${f.name}"?`,
            description: 'This folder is empty.',
            confirmLabel: 'Delete folder',
            destructive: true,
          });
          if (ok) await onDeleteFolder(f.id);
        }
      }}
      onDuplicate={() => onDuplicateFolder(f.id)}
      onShareWithLLM={() => onShareFolderWithLLM(f.id)}
      onOpenSettings={() => onOpenFolderSettings(f, 'general')}
      onSwitchViewMode={() =>
        void onChangeFolderViewMode(
          f,
          f.viewMode === 'kanban' ? 'list' : 'kanban',
        )
      }
      onMoveUp={() => onMoveFolder(f.id, 'up')}
      onMoveDown={() => onMoveFolder(f.id, 'down')}
      onExport={() => void exportFolderAsMarkdownZip(f.id, f.name)}
      onArchive={
        onArchiveFolder
          ? async () => {
              const ok = await confirm({
                title: `Archive folder "${f.name}"?`,
                description:
                  'It will be hidden from lists + search + MCP. You can restore it via "Show Archived" in the gear menu.',
                confirmLabel: 'Archive',
              });
              if (ok) await onArchiveFolder(f.id);
            }
          : undefined
      }
      onUnarchive={
        onUnarchiveFolder ? () => onUnarchiveFolder(f.id) : undefined
      }
      onDragStart={(e) => {
        // Helper extracted so the WKWebView setData contract is
        // unit-testable. Without setData, Tauri desktop drag never
        // initiates. Ticket `01KQ2WG1B0XEVV3EKT43357B4H`.
        applyFolderDragStart(e.dataTransfer, f.id, setDraggedFolderId);
      }}
      onDragOver={(e) => {
        if (isNoteDrag(e)) {
          e.preventDefault();
          setDropTarget(f.id);
          return;
        }
        // Accept any folder-drag. The view-mode group filter (list vs
        // kanban) and self-drop guard happen inside
        // computeReorderedFolderIds on drop; a cross-group drop returns
        // null and is a quiet no-op. We can't read the source folder's
        // viewMode here because HTML5 only exposes dataTransfer values
        // via `getData` on the drop event, not on dragover.
        if (isFolderDrag(e)) {
          e.preventDefault();
          if (draggedFolderId !== f.id) setDropTarget(f.id);
        }
      }}
      onDragLeave={() => {
        if (dropTarget === f.id) setDropTarget(null);
      }}
      onDrop={(e) => handleFolderDrop(f.id, e)}
      onDragEnd={() => {
        setDraggedFolderId(null);
        setDropTarget(null);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setFolderContext({
          folder: f,
          x: e.clientX,
          y: e.clientY,
          isFirst: groupIndex === 0,
          isLast: groupIndex === groupLength - 1,
        });
      }}
    />
  );

  return (
    <>
      <div className="mt-4 mb-1 flex items-center justify-between px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Folders
        </span>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title="New folder"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {listFolders.map((f, idx) => renderRow(f, idx, listFolders.length))}

      {creating && (
        <FolderCreateInput
          onSubmit={async (name) => {
            setCreating(false);
            if (name) await onCreateFolder(name);
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      <div className="mt-4 mb-1 flex items-center justify-between px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Kanban
        </span>
        <button
          type="button"
          onClick={() => {
            setCreatingKanban(true);
          }}
          className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title="New kanban board"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {kanbanFolders.map((f, idx) => renderRow(f, idx, kanbanFolders.length))}
      {creatingKanban && (
        <FolderCreateInput
          placeholder="Kanban board name"
          viewMode="kanban"
          onSubmit={async (name) => {
            setCreatingKanban(false);
            if (name) await onCreateKanbanFolder(name);
          }}
          onCancel={() => setCreatingKanban(false)}
        />
      )}
    </>
  );
}
