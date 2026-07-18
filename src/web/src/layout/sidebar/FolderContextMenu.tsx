import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  Folder as FolderIcon,
  LayoutGrid,
  Pencil,
  Share2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { Folder } from '../../lib/api';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from '../../components/ContextMenu';
import { useConfirm } from '../../components/ConfirmDialog';
import { exportFolderAsMarkdownZip } from '../../lib/exportFolder';

/** Anchored context-menu state — captured at right-click time on a
 *  FolderRow. Boundary flags (`isFirst` / `isLast`) are snapshotted
 *  so "Move up/down" enable state stays correct even if the folder
 *  list re-renders between right-click and menu close. */
export interface FolderContextState {
  folder: Folder;
  x: number;
  y: number;
  isFirst: boolean;
  isLast: boolean;
}

/** Right-click context menu for a sidebar folder row. Owns all of the
 *  destructive-action confirm dialogs (archive / delete). Inline JSX
 *  was 178 LOC in Sidebar.tsx before extraction. */
export function FolderContextMenu({
  state,
  onClose,
  onShareWithLLM,
  onOpenSettings,
  onSwitchViewMode,
  onStartRename,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  state: FolderContextState;
  onClose: () => void;
  onShareWithLLM: (id: string) => Promise<void> | void;
  onOpenSettings: (
    folder: Folder,
    tab?: import('../../components/FolderSettingsDialog').FolderSettingsTab,
  ) => void;
  onSwitchViewMode: (
    folder: Folder,
    mode: 'list' | 'kanban',
  ) => Promise<void> | void;
  onStartRename: (id: string) => void;
  onDuplicate: (id: string) => Promise<void> | void;
  onMoveUp: (id: string) => Promise<void> | void;
  onMoveDown: (id: string) => Promise<void> | void;
  onArchive?: (id: string) => Promise<void> | void;
  onUnarchive?: (id: string) => Promise<void> | void;
  onDelete: (id: string, opts?: { keepNotes?: boolean }) => Promise<void> | void;
}) {
  const confirm = useConfirm();

  return (
    <ContextMenu
      x={state.x}
      y={state.y}
      onClose={onClose}
      ariaLabel={`Actions for folder ${state.folder.name}`}
    >
      {/* Section: action — copy folder reference into LLM clipboard. */}
      <ContextMenuItem
        icon={<Share2 className="h-3.5 w-3.5" />}
        label="Share with LLM"
        onClick={() => {
          const id = state.folder.id;
          onClose();
          void onShareWithLLM(id);
        }}
      />
      <ContextMenuSeparator />
      {/* Section: settings — single entry to the unified Folder
          Settings popup (General / Access Permissions / Indexed
          Summary / Indexed Topics / Auto-code). */}
      <ContextMenuItem
        icon={<Sparkles className="h-3.5 w-3.5" />}
        label="Folder Settings"
        onClick={() => {
          const f = state.folder;
          onClose();
          onOpenSettings(f, 'general');
        }}
      />
      <ContextMenuSeparator />
      {/* Section: view — switch list/kanban (room for calendar later). */}
      <ContextMenuItem
        icon={
          state.folder.viewMode === 'kanban' ? (
            <FolderIcon className="h-3.5 w-3.5" />
          ) : (
            <LayoutGrid className="h-3.5 w-3.5" />
          )
        }
        label={
          state.folder.viewMode === 'kanban' ? 'Switch to List' : 'Switch to Kanban'
        }
        onClick={() => {
          const f = state.folder;
          onClose();
          void onSwitchViewMode(
            f,
            f.viewMode === 'kanban' ? 'list' : 'kanban',
          );
        }}
      />
      <ContextMenuSeparator />
      {/* Section: folder ops. */}
      <ContextMenuItem
        icon={<Pencil className="h-3.5 w-3.5" />}
        label="Rename"
        onClick={() => {
          const id = state.folder.id;
          onClose();
          onStartRename(id);
        }}
      />
      <ContextMenuItem
        icon={<Copy className="h-3.5 w-3.5" />}
        label="Duplicate"
        onClick={() => {
          const id = state.folder.id;
          onClose();
          void onDuplicate(id);
        }}
      />
      <ContextMenuItem
        icon={<Download className="h-3.5 w-3.5" />}
        label="Export to .md"
        onClick={() => {
          const f = state.folder;
          onClose();
          void exportFolderAsMarkdownZip(f.id, f.name);
        }}
      />
      <ContextMenuItem
        icon={<ArrowUp className="h-3.5 w-3.5" />}
        label="Move up"
        disabled={state.isFirst}
        onClick={() => {
          const id = state.folder.id;
          onClose();
          void onMoveUp(id);
        }}
      />
      <ContextMenuItem
        icon={<ArrowDown className="h-3.5 w-3.5" />}
        label="Move down"
        disabled={state.isLast}
        onClick={() => {
          const id = state.folder.id;
          onClose();
          void onMoveDown(id);
        }}
      />
      <ContextMenuSeparator />
      {/* Section: destructive. */}
      {state.folder.archivedAt == null
        ? onArchive && (
            <ContextMenuItem
              icon={<Archive className="h-3.5 w-3.5" />}
              label="Archive"
              onClick={() => {
                const f = state.folder;
                onClose();
                void (async () => {
                  const ok = await confirm({
                    title: `Archive folder "${f.name}"?`,
                    description:
                      'It will be hidden from lists + search + MCP. You can restore it via "Show Archived" in the gear menu.',
                    confirmLabel: 'Archive',
                  });
                  if (ok) await onArchive(f.id);
                })();
              }}
            />
          )
        : onUnarchive && (
            <ContextMenuItem
              icon={<ArchiveRestore className="h-3.5 w-3.5" />}
              label="Unarchive"
              onClick={() => {
                const id = state.folder.id;
                onClose();
                void onUnarchive(id);
              }}
            />
          )}
      <ContextMenuItem
        icon={<Trash2 className="h-3.5 w-3.5" />}
        label="Delete"
        destructive
        onClick={() => {
          const f = state.folder;
          onClose();
          void (async () => {
            const noteWord =
              f.noteCount === 1
                ? 'note inside'
                : `notes inside (${f.noteCount})`;
            if (f.noteCount > 0) {
              const result = await confirm({
                title: `Delete folder "${f.name}"?`,
                description: `The ${noteWord} will be moved to Trash (restorable).`,
                confirmLabel: 'Delete folder',
                destructive: true,
                checkbox: {
                  label: 'Keep notes instead (leave them unfiled)',
                },
              });
              if (result.confirmed)
                await onDelete(f.id, {
                  keepNotes: result.checkboxChecked,
                });
            } else {
              const ok = await confirm({
                title: `Delete folder "${f.name}"?`,
                description: 'This folder is empty.',
                confirmLabel: 'Delete folder',
                destructive: true,
              });
              if (ok) await onDelete(f.id);
            }
          })();
        }}
      />
    </ContextMenu>
  );
}
