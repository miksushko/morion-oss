declare const __APP_VERSION__: string;

import { useState } from 'react';
import {
  Plus,
  Hash,
  Inbox,
  Trash2,
  Search as SearchIcon,
} from 'lucide-react';
import type { Folder, FolderViewMode } from '../lib/api';
import type { AppView } from '../appShellTypes';
import { HeaderMenu } from '../components/HeaderMenu';
import { cn } from '../lib/cn';
import { NOTE_DRAG_MIME } from './NotesList';
import { SidebarItem } from './sidebar/SidebarItem';
import { ConciergeNavItem } from './sidebar/ConciergeNavItem';
import { FolderRenameInput } from './sidebar/FolderRenameInput';
import { FolderCreateInput } from './sidebar/FolderCreateInput';
import { FolderRow } from './sidebar/FolderRow';
import {
  FolderContextMenu,
  type FolderContextState,
} from './sidebar/FolderContextMenu';
import { FolderTree } from './sidebar/FolderTree';

import logoDark from '../assets/logo-dark.svg';
import logoLight from '../assets/logo-light.svg';
import { useTheme } from '../theme/ThemeProvider';

interface Props {
  folders: Folder[];
  view: AppView;
  selectedFolderId: string | undefined;
  totalNoteCount: number;
  tagCount: number;
  /** Number of notes currently in the trash (within the 7-day retention window). */
  trashCount: number;
  /** Master MCP toggle state — drives the small status dot overlay on the header gear icon. */
  mcpEnabled: boolean;
  onSelectFolder: (folderId: string | undefined) => void;
  onSelectView: (view: AppView) => void;
  onCreateFolder: (name: string) => Promise<void> | void;
  /** Create a folder pre-flipped to kanban mode. Parent handles the
   * server round-trip (folder create + setFolderViewMode). */
  onCreateKanbanFolder: (name: string) => Promise<void> | void;
  onRenameFolder: (id: string, name: string) => Promise<void> | void;
  onDeleteFolder: (
    id: string,
    opts?: { keepNotes?: boolean },
  ) => Promise<void> | void;
  onDuplicateFolder: (id: string) => Promise<void> | void;
  onMoveFolder: (id: string, direction: 'up' | 'down') => Promise<void> | void;
  onReorderFolders: (orderedIds: string[]) => Promise<void> | void;
  onMoveNoteToFolder: (noteId: string, targetFolderId: string | null) => Promise<void> | void;
  /** Copy a paste-into-LLM payload referencing the folder + every note id in it. */
  onShareFolderWithLLM: (id: string) => Promise<void> | void;
  /** Open the unified per-folder settings dialog (AI Access / Mo Workflow /
   * Mo Project Memory tabs). Replaces the previous separate AI Access,
   * Mo settings, and View Project Brief callbacks. Optional `tab` deep-
   * links to a specific section. */
  onOpenFolderSettings: (folder: Folder, tab?: import('../components/FolderSettingsDialog').FolderSettingsTab) => void;
  /** Flip a folder between list and kanban modes. Parent owns the
   * kanban→list confirm dialog. */
  onChangeFolderViewMode: (folder: Folder, mode: FolderViewMode) => Promise<void> | void;
  onOpenSearch: () => void;
  /** Open the Import dialog. Forwarded to HeaderMenu. */
  onOpenImport?: () => void;
  /** Open the unified Settings popup (epic 01KPGWTJCWVBQCCSQ8NGSB19KQ).
   *  Forwarded to HeaderMenu. */
  onOpenUnifiedSettings?: () => void;
  /** Open the unified Settings popup deep-linked to the MCP Server tab.
   *  Wired to the footer "MCP server: online/offline" status pill. */
  onOpenMcpSettings?: () => void;
  /** "Review MCP access" toggle — true renders a V/C/E/D permission
   * strip next to each folder name. Toggle state lives in App.tsx. */
  reviewMcp?: boolean;
  onToggleReviewMcp?: () => void;
  /** "Show Archived" toggle — surfaces archived folders + notes with a
   * muted badge. State persisted by App in localStorage. */
  showArchived?: boolean;
  onToggleShowArchived?: () => void;
  /** Archive a folder (soft-hide; restorable via unarchive). Prompts
   * through useConfirm at the row menu. */
  onArchiveFolder?: (id: string) => Promise<void> | void;
  onUnarchiveFolder?: (id: string) => Promise<void> | void;
  /** Direction V — count of Concierge chats awaiting a human reply.
   * Drives the badge on the Concierge nav entry. Null-safe: if the
   * runtime doesn't wire Concierge the count stays 0 and the row
   * still renders (it just never badges). */
  conciergeNeedsHumanCount?: number;
  /** Direction V — true while any Concierge session is mid-reply
   * (`POST /messages` fetch in flight). When user switches away from
   * the Ask Mo panel mid-reply, the thinking animation on this row
   * tells them Mo is still working in the background. */
  conciergeThinking?: boolean;
}

/**
 * Sidebar handles two unrelated drag flows:
 *
 *   1. Folder reorder — folder rows are draggable; dragstart sets `draggedFolderId`
 *      via React state and dragover/drop on another folder row swaps positions.
 *
 *   2. Note move — NotesList rows are draggable and put a note id on the
 *      `application/x-morion-note` mime. We sniff `dataTransfer.types` (the
 *      payload itself isn't readable on dragover, only on drop) to know we're
 *      looking at a note drag rather than a folder drag, light up the target
 *      row, and on drop call `onMoveNoteToFolder`.
 *
 * "All notes" doubles as the unfile drop target — dropping a note here sets
 * folderId = null. Inbox is gone; an unfiled note simply lives in All notes
 * with no folder badge.
 */
export function Sidebar({
  folders,
  view,
  selectedFolderId,
  totalNoteCount,
  tagCount,
  trashCount,
  conciergeNeedsHumanCount = 0,
  conciergeThinking = false,
  mcpEnabled,
  onOpenMcpSettings,
  onSelectFolder,
  onSelectView,
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
  onOpenSearch,
  onOpenImport,
  onOpenUnifiedSettings,
  reviewMcp,
  onToggleReviewMcp,
  showArchived,
  onToggleShowArchived,
  onArchiveFolder,
  onUnarchiveFolder,
}: Props) {
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform);
  const searchHint = isMac ? '⌘K' : 'Ctrl+K';
  const [creating, setCreating] = useState(false);
  // Direction N: separate inline create input for kanban folders so the
  // row renders inside the Kanban section, not the Folders one.
  const [creatingKanban, setCreatingKanban] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
  // Drop highlight target. `'all'` is the All notes row; otherwise a folder id.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Right-click context menu state. Anchored to (clientX, clientY); the boundary
  // flags are snapshotted at click time so the menu's Move up/down disable state
  // matches the row the user actually right-clicked on.
  const [folderContext, setFolderContext] = useState<FolderContextState | null>(
    null,
  );

  const isNoteDrag = (e: React.DragEvent): boolean =>
    e.dataTransfer.types.includes(NOTE_DRAG_MIME);

  const handleAllNotesDragOver = (e: React.DragEvent) => {
    if (!isNoteDrag(e)) return;
    e.preventDefault();
    setDropTarget('all');
  };

  const handleAllNotesDrop = (e: React.DragEvent) => {
    setDropTarget(null);
    if (!isNoteDrag(e)) return;
    e.preventDefault();
    const noteId = e.dataTransfer.getData(NOTE_DRAG_MIME);
    if (noteId) void onMoveNoteToFolder(noteId, null);
  };

  const { theme } = useTheme();
  const allNotesActive = view === 'notes' && selectedFolderId === undefined;
  const tagsActive = view === 'tags';
  const trashActive = view === 'trash';

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-card md:w-60">
      <div className="flex items-center justify-between pl-4 pr-3 py-3">
        <img
          src={theme === 'dark' ? logoDark : logoLight}
          alt="Morion"
          className="h-7 max-w-[140px]"
        />
        {onOpenUnifiedSettings && (
          <HeaderMenu
            reviewMcp={reviewMcp}
            onToggleReviewMcp={onToggleReviewMcp}
            showArchived={showArchived}
            onToggleShowArchived={onToggleShowArchived}
            onOpenImport={onOpenImport}
            onOpenUnifiedSettings={onOpenUnifiedSettings}
          />
        )}
      </div>

      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={onOpenSearch}
          className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Search notes"
        >
          <SearchIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 truncate">Search</span>
          <kbd className="shrink-0 rounded border border-border px-1 py-0.5 text-[10px] font-medium tabular-nums">
            {searchHint}
          </kbd>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-1 pb-3 pt-1 text-sm">
        <div className="mb-1 px-3 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Library
        </div>
        <SidebarItem
          icon={<Inbox className="h-3.5 w-3.5" />}
          label="All notes"
          count={totalNoteCount}
          active={allNotesActive}
          isDropTarget={dropTarget === 'all'}
          onClick={() => onSelectFolder(undefined)}
          onDragOver={handleAllNotesDragOver}
          onDragLeave={() => {
            if (dropTarget === 'all') setDropTarget(null);
          }}
          onDrop={handleAllNotesDrop}
        />
        <SidebarItem
          icon={<Hash className="h-3.5 w-3.5" />}
          label="Tags"
          count={tagCount}
          active={tagsActive}
          onClick={() => onSelectView('tags')}
        />
        <ConciergeNavItem
          active={view === 'concierge'}
          needsHumanCount={conciergeNeedsHumanCount}
          thinking={conciergeThinking}
          onClick={() => onSelectView('concierge')}
        />

        <FolderTree
          folders={folders}
          view={view}
          selectedFolderId={selectedFolderId}
          reviewMcp={reviewMcp}
          editingId={editingId}
          setEditingId={setEditingId}
          draggedFolderId={draggedFolderId}
          setDraggedFolderId={setDraggedFolderId}
          dropTarget={dropTarget}
          setDropTarget={setDropTarget}
          setFolderContext={setFolderContext}
          creating={creating}
          setCreating={setCreating}
          creatingKanban={creatingKanban}
          setCreatingKanban={setCreatingKanban}
          onSelectFolder={onSelectFolder}
          onCreateFolder={onCreateFolder}
          onCreateKanbanFolder={onCreateKanbanFolder}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
          onDuplicateFolder={onDuplicateFolder}
          onMoveFolder={onMoveFolder}
          onReorderFolders={onReorderFolders}
          onMoveNoteToFolder={onMoveNoteToFolder}
          onShareFolderWithLLM={onShareFolderWithLLM}
          onOpenFolderSettings={onOpenFolderSettings}
          onChangeFolderViewMode={onChangeFolderViewMode}
          onArchiveFolder={onArchiveFolder}
          onUnarchiveFolder={onUnarchiveFolder}
        />

        <div className="mt-4 mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          System
        </div>
        <SidebarItem
          icon={<Trash2 className="h-3.5 w-3.5" />}
          label="Trash"
          count={trashCount}
          active={trashActive}
          onClick={() => onSelectView('trash')}
        />
      </nav>

      {/* Sidebar footer — MCP status (clickable → Settings) + version badge */}
      <div
        className="flex items-center justify-between border-t border-border px-3 py-1.5"
        aria-live="polite"
      >
        <button
          type="button"
          onClick={() => onOpenMcpSettings?.()}
          className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <span
            aria-hidden
            className={cn(
              'inline-block h-1.5 w-1.5 rounded-full',
              mcpEnabled ? 'bg-emerald-500' : 'bg-muted-foreground/50',
            )}
          />
          MCP server: {mcpEnabled ? 'online' : 'offline'}
        </button>
        <span className="text-[11px] text-muted-foreground/60">v{__APP_VERSION__}</span>
      </div>

      {folderContext && (
        <FolderContextMenu
          state={folderContext}
          onClose={() => setFolderContext(null)}
          onShareWithLLM={onShareFolderWithLLM}
          onOpenSettings={onOpenFolderSettings}
          onSwitchViewMode={onChangeFolderViewMode}
          onStartRename={(id) => setEditingId(id)}
          onDuplicate={onDuplicateFolder}
          onMoveUp={(id) => onMoveFolder(id, 'up')}
          onMoveDown={(id) => onMoveFolder(id, 'down')}
          onArchive={onArchiveFolder}
          onUnarchive={onUnarchiveFolder}
          onDelete={onDeleteFolder}
        />
      )}
    </aside>
  );
}



