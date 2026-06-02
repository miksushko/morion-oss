import { api } from '../lib/api';
import { KanbanView } from '../layout/KanbanView';
import { KanbanCardModal } from '../layout/KanbanCardModal';
import { EditorPane } from '../layout/EditorPane';
import { NoteRightPanel } from './NoteRightPanel';
import { KanbanStatusControl } from './KanbanStatusControl';
import { KanbanCardNavigator } from './KanbanCardNavigator';
import { kanbanCardNeighbours } from '../lib/kanbanOrder';
import { cn } from '../lib/cn';
import type {
  Folder,
  FolderViewMode,
  Note,
  NoteRevision,
  NoteStatus,
  Tag,
} from '../lib/api';
import type { MobilePane, SaveState } from '../appShellTypes';
import type { FolderSettingsTab } from './FolderSettingsDialog';

/**
 * Kanban-folder render branch: `<KanbanView />` board + the per-card
 * `<KanbanCardModal />` with side activity panel + EditorPane inside.
 *
 * Mounted only when `activeFolder?.viewMode === 'kanban'`. The auto-
 * code toggle has an inline PUT — on validation failure we re-open the
 * unified Folder Settings popup on the Auto-code tab.
 */
export interface KanbanFolderViewProps {
  activeFolder: Folder;
  folders: Folder[];
  visibleNotes: Note[];
  tags: Tag[];
  selectedNote: Note | null;
  saveStates: Map<string, SaveState>;
  editorSyncToken: number;
  liveRev: number;
  conciergeFolderEnabled: Record<string, boolean>;
  autoCodeFolderEnabled: Record<string, boolean>;
  setAutoCodeFolderEnabled: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  kanbanActivityCollapsed: boolean;
  setKanbanActivityCollapsed: React.Dispatch<React.SetStateAction<boolean>>;

  paneClass: (pane: MobilePane) => string;
  setMobilePane: (pane: MobilePane) => void;

  // Note ops
  onNewNote: () => void | Promise<void>;
  onShareNoteWithLLM: (id: string) => Promise<void>;
  onCopyNoteBody: (id: string) => Promise<void>;
  onDuplicateNote: (id: string) => Promise<void>;
  onMoveNote: (id: string, target: string | null) => Promise<void>;
  onDeleteNote: (id: string) => Promise<void>;
  onArchiveNote: (id: string) => Promise<void>;
  onUnarchiveNote: (id: string) => Promise<void>;
  onBulkDeleteNotes: (ids: string[]) => Promise<void>;
  onBulkArchiveNotes: (ids: string[]) => Promise<void>;
  onBulkUnarchiveNotes: (ids: string[]) => Promise<void>;
  onBulkMoveNotes: (ids: string[], target: string | null) => Promise<void>;
  onEditNote: (patch: { body?: string }) => void;
  onUpdateNoteTags: (id: string, tags: string[]) => Promise<void>;
  onDeleteSelected: () => Promise<void>;

  // Selected-note wrappers
  onShareSelectedWithLLM: () => Promise<void>;
  onCopySelectedBody: () => Promise<void>;
  onDuplicateSelectedNote: () => Promise<void>;
  onMoveSelectedNoteToFolder: (target: string | null) => Promise<void>;

  // Tag + revision
  onCreateTag: (name: string, color: string | null) => Promise<Tag>;
  onRestoreRevision: (revision: NoteRevision) => Promise<void>;
  onCopyRevisionBody: (revision: NoteRevision) => Promise<void>;

  // Kanban ops
  onShareFolderWithLLM: (id: string) => Promise<void>;
  onChangeFolderViewMode: (folder: Folder, next: FolderViewMode) => Promise<void>;
  onOpenFolderSettings: (folder: Folder, tab: FolderSettingsTab) => void;
  onOpenCard: (id: string) => void;
  onAddCard: (status: NoteStatus) => Promise<void>;
  onMoveTask: (id: string, status: NoteStatus, afterId: string | null) => Promise<void>;
  onCloseDrawer: () => void;

  // Dialogs / overlays
  onRequestAIAccess: (target: { kind: 'note'; note: Note; folder: Folder | null }) => void;

  showToast: (msg: string) => void;
}

export function KanbanFolderView(props: KanbanFolderViewProps) {
  const {
    activeFolder,
    folders,
    visibleNotes,
    tags,
    selectedNote,
    saveStates,
    editorSyncToken,
    liveRev,
    conciergeFolderEnabled,
    autoCodeFolderEnabled,
    setAutoCodeFolderEnabled,
    kanbanActivityCollapsed,
    setKanbanActivityCollapsed,
    paneClass,
    setMobilePane,
    onNewNote,
    onShareNoteWithLLM,
    onCopyNoteBody,
    onDuplicateNote,
    onMoveNote,
    onDeleteNote,
    onArchiveNote,
    onUnarchiveNote,
    onBulkDeleteNotes,
    onBulkArchiveNotes,
    onBulkUnarchiveNotes,
    onBulkMoveNotes,
    onEditNote,
    onUpdateNoteTags,
    onDeleteSelected,
    onShareSelectedWithLLM,
    onCopySelectedBody,
    onDuplicateSelectedNote,
    onMoveSelectedNoteToFolder,
    onCreateTag,
    onRestoreRevision,
    onCopyRevisionBody,
    onShareFolderWithLLM,
    onChangeFolderViewMode,
    onOpenFolderSettings,
    onOpenCard,
    onAddCard,
    onMoveTask,
    onCloseDrawer,
    onRequestAIAccess,
    showToast,
  } = props;

  return (
    <div className={cn('min-w-0 flex-1', paneClass('notes'), paneClass('editor'))}>
      <KanbanView
        folder={activeFolder}
        notes={visibleNotes}
        folders={folders}
        allTags={tags}
        onMobileBack={() => setMobilePane('folders')}
        onNewNote={onNewNote}
        onShareFolderWithLLM={() => onShareFolderWithLLM(activeFolder.id)}
        onChangeFolderViewMode={(next) => onChangeFolderViewMode(activeFolder, next)}
        onOpenConciergeSettings={() => onOpenFolderSettings(activeFolder, 'access')}
        conciergeEnabled={conciergeFolderEnabled[activeFolder.id] ?? false}
        autoCodeEnabled={autoCodeFolderEnabled[activeFolder.id] ?? false}
        onToggleAutoCode={async (next) => {
          try {
            const updated = await api.putConciergeFolderSettings(activeFolder.id, {
              autoCodeEnabled: next,
            });
            setAutoCodeFolderEnabled((prev) => ({
              ...prev,
              [activeFolder.id]: updated.autoCodeEnabled,
            }));
          } catch (err) {
            // Validation failure (no Mo, no linked repo, etc.) →
            // open the unified Folder Settings popup on the Auto-code
            // tab so the user can fix it inline.
            console.warn('[auto-code] toggle failed:', err);
            onOpenFolderSettings(activeFolder, 'auto-code');
          }
        }}
        onOpenAutoCodeSettings={() => onOpenFolderSettings(activeFolder, 'auto-code')}
        onOpenCard={onOpenCard}
        onAddCardToColumn={onAddCard}
        onMoveTask={onMoveTask}
        onShareNoteWithLLM={onShareNoteWithLLM}
        onCopyNoteBody={onCopyNoteBody}
        onDuplicateNote={onDuplicateNote}
        onMoveNoteToFolder={onMoveNote}
        onDeleteNote={onDeleteNote}
        onArchiveNote={onArchiveNote}
        onUnarchiveNote={onUnarchiveNote}
        onBulkMoveNotesToFolder={onBulkMoveNotes}
        onBulkDeleteNotes={onBulkDeleteNotes}
        onBulkArchiveNotes={onBulkArchiveNotes}
        onBulkUnarchiveNotes={onBulkUnarchiveNotes}
        onOpenNoteAIAccess={(note) =>
          onRequestAIAccess({
            kind: 'note',
            note,
            folder: folders.find((f) => f.id === note.folderId) ?? null,
          })
        }
      />
      <KanbanCardModal
        open={selectedNote !== null && selectedNote.folderId === activeFolder.id}
        onClose={onCloseDrawer}
        sidePanel={
          selectedNote ? (
            <NoteRightPanel
              noteId={selectedNote.id}
              noteTitle={selectedNote.title}
              currentActor="user"
              liveRev={liveRev}
              collapsed={kanbanActivityCollapsed}
              onToggleCollapse={() => setKanbanActivityCollapsed((v) => !v)}
              className={kanbanActivityCollapsed ? '' : 'w-[320px]'}
              onUploadError={(msg) => showToast(`Comment image upload failed: ${msg}`)}
            />
          ) : null
        }
        header={
          selectedNote ? (
            (() => {
              // ClickUp-style prev/next: walk the flat kanban-order
              // list. `visibleNotes` is already this folder's cards
              // (kanban mode filters by folder), so the neighbours
              // are honest without any extra fetching. Reuses the
              // single ordering source `orderKanbanCards` — same one
              // KanbanView uses to render — so "the card above on the
              // board" always maps to "Up arrow".
              const { prevId, nextId } = kanbanCardNeighbours(visibleNotes, selectedNote.id);
              return (
                <div className="flex min-w-0 items-center gap-2">
                  <KanbanStatusControl
                    value={selectedNote.status}
                    onChange={(next) => onMoveTask(selectedNote.id, next, null)}
                    className="min-w-0 flex-1"
                  />
                  <KanbanCardNavigator
                    prevId={prevId}
                    nextId={nextId}
                    onNavigate={onOpenCard}
                  />
                </div>
              );
            })()
          ) : null
        }
      >
        {selectedNote && (
          <EditorPane
            note={selectedNote}
            allTags={tags}
            folders={folders}
            onChange={onEditNote}
            onDelete={onDeleteSelected}
            onUpdateTags={(next) => {
              if (selectedNote) onUpdateNoteTags(selectedNote.id, next);
            }}
            onCreateTag={onCreateTag}
            onShareWithLLM={onShareSelectedWithLLM}
            onCopyBody={onCopySelectedBody}
            onDuplicate={onDuplicateSelectedNote}
            onMoveToFolder={onMoveSelectedNoteToFolder}
            onOpenAIAccess={
              selectedNote
                ? () =>
                    onRequestAIAccess({
                      kind: 'note',
                      note: selectedNote,
                      folder: folders.find((f) => f.id === selectedNote.folderId) ?? null,
                    })
                : undefined
            }
            onMobileBack={onCloseDrawer}
            onArchive={selectedNote ? () => onArchiveNote(selectedNote.id) : undefined}
            onUnarchive={selectedNote ? () => onUnarchiveNote(selectedNote.id) : undefined}
            onRestoreRevision={onRestoreRevision}
            onCopyRevisionBody={onCopyRevisionBody}
            externalSyncToken={editorSyncToken}
            saveState={selectedNote ? saveStates.get(selectedNote.id) ?? 'idle' : 'idle'}
            onImageUploadError={(msg) => showToast(`Image upload failed: ${msg}`)}
          />
        )}
      </KanbanCardModal>
    </div>
  );
}
