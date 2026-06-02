import type { AutoCodeQueueRow, Folder, Note, NoteStatus, Tag } from '../../lib/api';

export interface KanbanViewProps {
  folder: Folder;
  /** All non-deleted notes in this folder. Parent keeps them globally
   * so we inherit its optimistic-patch + WAL-sync refreshes for free. */
  notes: Note[];
  /** Every folder in the user's library. Feeds the "Move to…" submenu
   * on the card context menu. Same `folders` array the Sidebar /
   * NotesList use. */
  folders: Folder[];
  /** Full tag catalogue — used to colorize chips on the cards. Same
   * `tags` array NotesList / EditorPane consume. Without it, kanban
   * cards render gray neutral chips even though the tag has a color
   * configured in TagManager (the bug this prop was added to fix). */
  allTags?: Tag[];
  onMobileBack: () => void;
  onNewNote: () => void;
  onShareFolderWithLLM: () => void;
  /** Direction V — opens per-folder Concierge settings dialog when
   * provided. Parent gates by Pro / renders the dialog / handles the
   * "Launch" action inside the dialog itself. */
  onOpenConciergeSettings?: () => void;
  /** Concierge status for the trigger button — green dot when the
   * user has enabled it on this folder. Absent/undefined = no dot
   * (neutral state). */
  conciergeEnabled?: boolean;
  /** Concierge needs the user's attention on this board. Renders a
   * primary pill next to the trigger button. */
  conciergeNeedsHuman?: boolean;
  /** Auto-code state for the kanban-header toggle. Mirrors
   *  `concierge_folder_settings.auto_code_enabled` for this folder.
   *  Undefined = no opinion (renders nothing). */
  autoCodeEnabled?: boolean;
  /** Toggle handler. Parent owns the API call + error handling
   *  (popup auto-opens on validation failure). Async so the
   *  kanban view can show "Saving…" until it resolves. */
  onToggleAutoCode?: (next: boolean) => Promise<void> | void;
  /** Opens the auto-code popup (full-screen settings + workflows
   *  + visual editor). Always available when auto-code is wired
   *  for the workspace. */
  onOpenAutoCodeSettings?: () => void;
  /** Direction N — segmented toggle fires through this. Parent hosts the
   * confirm dialog for kanban→list ("agents lose access to statuses"). */
  onChangeFolderViewMode: (next: 'list' | 'kanban') => Promise<void> | void;
  /** Open the card modal on this note. */
  onOpenCard: (noteId: string) => void;
  /** Add a brand-new card directly into a named column (fires from the
   * "+ Add task" button at the bottom of each column). Parent creates
   * the note with that status and opens the modal. */
  onAddCardToColumn: (status: NoteStatus) => void;
  /** Apply a drag-and-drop move. Parent is responsible for optimistic
   * update + server call + refresh. afterNoteId=null means top-of-column. */
  onMoveTask: (
    noteId: string,
    status: NoteStatus,
    afterNoteId: string | null,
  ) => void;
  /** Card context-menu actions — mirror the ones NotesList exposes for
   * list-mode rows so users get a consistent right-click surface
   * regardless of the folder's view_mode. Parent owns the handlers +
   * toasts + optimistic state. */
  onShareNoteWithLLM: (id: string) => Promise<void> | void;
  onCopyNoteBody: (id: string) => Promise<void> | void;
  onDuplicateNote: (id: string) => Promise<void> | void;
  onMoveNoteToFolder: (id: string, folderId: string | null) => Promise<void> | void;
  onDeleteNote: (id: string) => Promise<void> | void;
  onArchiveNote?: (id: string) => Promise<void> | void;
  onUnarchiveNote?: (id: string) => Promise<void> | void;
  /** Bulk variants used by the Select-mode toolbar. Parent fires the
   * existing single-note handlers in a Promise.all so optimistic local
   * state + folder counts + trash refresh reuse one code path. */
  onBulkMoveNotesToFolder?: (ids: string[], folderId: string | null) => Promise<void> | void;
  onBulkDeleteNotes?: (ids: string[]) => Promise<void> | void;
  onBulkArchiveNotes?: (ids: string[]) => Promise<void> | void;
  onBulkUnarchiveNotes?: (ids: string[]) => Promise<void> | void;
  /** Open per-note AI access dialog (Pro) or the upsell modal (Free).
   * Optional — parent omits it where AI access doesn't apply. */
  onOpenNoteAIAccess?: (note: Note) => void;
}

export interface ColumnMeta {
  key: NoteStatus;
  label: string;
  accent: string;
  description: string;
}

export const COLUMN_META: ColumnMeta[] = [
  { key: 'note', label: 'Note', accent: 'bg-muted/40', description: 'Reference / idea' },
  { key: 'backlog', label: 'Backlog', accent: 'bg-slate-500/10', description: 'Queued work' },
  { key: 'todo', label: 'Todo', accent: 'bg-sky-500/10', description: 'Ready to start' },
  { key: 'doing', label: 'Doing', accent: 'bg-amber-500/10', description: 'In progress' },
  { key: 'review', label: 'Review', accent: 'bg-violet-500/10', description: 'Awaiting review' },
  { key: 'done', label: 'Done', accent: 'bg-emerald-500/10', description: 'Complete' },
];

/** Shared per-card render concerns passed down through column → card. */
export interface CardRenderCtx {
  tagColorByName: Map<string, string | null>;
  autoCodeRows: Map<string, AutoCodeQueueRow>;
  onOpenAutoCode: (row: AutoCodeQueueRow) => void;
}
