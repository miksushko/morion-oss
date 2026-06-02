import type { Folder, Note, Tag } from '../../lib/api';

/** Public props for the `NotesList` shell. Kept in a separate module so
 *  the shell file stays focused on composition + render logic. */
export interface NotesListProps {
  notes: Note[];
  folders: Folder[];
  /** Full tag catalogue — used to resolve the dot color for each note's tags. */
  allTags: Tag[];
  /** Show a small folder badge under each note (used in the All-notes view). */
  showFolderBadges: boolean;
  /** Title shown in the pane header — folder name, or "All notes" for the unfiled view. */
  folderTitle: string;
  /** Currently-selected folder object — used to wire the header's More
   *  menu to per-folder operations. Null in All-notes view + Trash.
   *  When null, the More button is hidden. */
  folder?: Folder | null;
  /** Open the per-folder settings popup. App-level handler — same one
   *  the folder-tree context menu in Sidebar uses. */
  onOpenFolderSettings?: (folder: Folder) => void;
  /** Per-folder operation callbacks shown in the header More menu.
   *  Each one mirrors a Sidebar folder-row context-menu action. All
   *  optional; the More button only renders when these + `folder`
   *  + `onOpenFolderSettings` are all present. */
  onRenameFolder?: (folder: Folder) => void;
  onDuplicateFolder?: (folder: Folder) => void;
  onExportFolder?: (folder: Folder) => void;
  onMoveFolder?: (folder: Folder, direction: 'up' | 'down') => void;
  onArchiveFolder?: (folder: Folder) => void;
  onUnarchiveFolder?: (folder: Folder) => void;
  onDeleteFolder?: (folder: Folder) => void;
  /** Order/index hints so the menu can disable Move up / Move down
   *  at the boundary positions. When undefined, both moves enabled. */
  folderCanMoveUp?: boolean;
  folderCanMoveDown?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewNote: () => void;
  /** Mobile back button — pops the pane stack to the folders pane. Hidden on md+. */
  onMobileBack: () => void;
  /** How many notes we've fetched so far (across paginated loads). */
  loadedCount: number;
  /** Total notes the server reports via X-Total-Count. */
  totalCount: number;
  /** Called when the user scrolls near the bottom and more notes exist. */
  onLoadMore: () => void;
  /**
   * Share the *currently open folder* (project) as a paste-into-LLM payload.
   * `null` when the All-notes view is open — we only share concrete projects,
   * not the whole notebook (that would explode the clipboard).
   */
  onShareFolderWithLLM: (() => Promise<void> | void) | null;
  /** Direction N — segmented view-mode toggle. Fires only for non-active
   * modes (clicking "List" when already list is a no-op). Parent hosts
   * the confirm dialog for kanban flips (we pass 'kanban' here only for
   * silent upgrades). Null when no concrete folder is open (All notes,
   * Trash). */
  onChangeFolderViewMode?: ((next: 'list' | 'kanban') => Promise<void> | void) | null;
  /** Right-click context menu actions — operate on the right-clicked note id, not the selection. */
  onShareNoteWithLLM: (id: string) => Promise<void> | void;
  onCopyNoteBody: (id: string) => Promise<void> | void;
  onDuplicateNote: (id: string) => Promise<void> | void;
  onMoveNoteToFolder: (id: string, folderId: string | null) => Promise<void> | void;
  onDeleteNote: (id: string) => Promise<void> | void;
  onArchiveNote?: (id: string) => Promise<void> | void;
  onUnarchiveNote?: (id: string) => Promise<void> | void;
  /** Open the per-note MCP access dialog (Pro) or the upsell modal (Free).
   * Optional so trash mode + tests can omit it. */
  onOpenNoteAIAccess?: (note: Note) => void;
  /**
   * Trash mode hides the New / Share-folder buttons in the header, drops the
   * row drag handle, disables the right-click context menu, and switches the
   * timestamp from "Edited X" to "Deleted X". Restore is the only mutation
   * available — it lives in the editor pane, not on each row.
   */
  trashMode?: boolean;
  /**
   * Empty the trash — only meaningful in `trashMode`. Renders a header
   * button that prompts for confirmation before hard-deleting every
   * currently-trashed note. The parent owns the actual confirm + API call.
   */
  onEmptyTrash?: () => Promise<void> | void;
  /** "Review MCP access" mode — when true, each row grows a compact
   * V/E/D permission strip next to the title. Toggle lives in gear menu. */
  reviewMcp?: boolean;
}
