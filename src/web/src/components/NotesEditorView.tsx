import { MessageCircle } from 'lucide-react';
import { NotesList } from '../layout/NotesList';
import { EditorPane } from '../layout/EditorPane';
import { NoteRightPanel } from './NoteRightPanel';
import { cn } from '../lib/cn';
import { exportFolderAsMarkdownZip } from '../lib/exportFolder';
import type { Folder, FolderViewMode, Note, NoteRevision, Tag } from '../lib/api';
import type { MobilePane, SaveState } from '../appShellTypes';
import type { useConfirm } from './ConfirmDialog';
import type { usePrompt } from './PromptDialog';

type Confirm = ReturnType<typeof useConfirm>;
type Prompt = ReturnType<typeof usePrompt>;

/**
 * Default branch of the App render: NotesList + EditorPane side-by-side
 * (or stacked on mobile via `paneClass`). Rendered when no special view
 * is active (not tags / concierge / trash / kanban / welcome screen).
 *
 * The prop surface is wide but mechanical — every callback is the
 * same one App used inline, just lifted into props so the JSX wall
 * lives in its own module. No new behaviour.
 */
export interface NotesEditorViewProps {
  // Data
  visibleNotes: Note[];
  allNotes: Note[];
  totalNotes: number;
  folders: Folder[];
  tags: Tag[];
  activeFolder: Folder | undefined;
  selectedFolderId: string | undefined;
  selectedId: string | null;
  selectedNote: Note | null;
  saveStates: Map<string, SaveState>;
  editorSyncToken: number;
  liveRev: number;
  reviewMcp: boolean;
  editorActivityCollapsed: boolean;
  setEditorActivityCollapsed: React.Dispatch<React.SetStateAction<boolean>>;

  // Layout
  paneClass: (pane: MobilePane) => string;
  setMobilePane: (pane: MobilePane) => void;

  // Note ops
  onSelectNote: (id: string) => void;
  onNewNote: () => void | Promise<void>;
  onDeleteNote: (id: string) => Promise<void>;
  onArchiveNote: (id: string) => Promise<void>;
  onUnarchiveNote: (id: string) => Promise<void>;
  onDuplicateNote: (id: string) => Promise<void>;
  onMoveNote: (id: string, target: string | null) => Promise<void>;
  onShareNoteWithLLM: (id: string) => Promise<void>;
  onCopyNoteBody: (id: string) => Promise<void>;
  onLoadMore: () => void | Promise<void>;
  onEditNote: (patch: { body?: string }) => void;
  onUpdateNoteTags: (id: string, tags: string[]) => Promise<void>;
  onDeleteSelected: () => Promise<void>;

  // Selected-note convenience
  onShareSelectedWithLLM: () => Promise<void>;
  onCopySelectedBody: () => Promise<void>;
  onDuplicateSelectedNote: () => Promise<void>;
  onMoveSelectedNoteToFolder: (target: string | null) => Promise<void>;

  // Folder ops
  onCreateTag: (name: string, color: string | null) => Promise<Tag>;
  onRenameFolder: (id: string, name: string) => Promise<void>;
  onDeleteFolder: (id: string) => Promise<void>;
  onArchiveFolder: (id: string) => Promise<void>;
  onUnarchiveFolder: (id: string) => Promise<void>;
  onDuplicateFolder: (id: string) => Promise<void>;
  onMoveFolder: (id: string, direction: 'up' | 'down') => Promise<void>;
  onShareFolderWithLLM: (id: string) => Promise<void>;
  onChangeFolderViewMode: (folder: Folder, next: FolderViewMode) => Promise<void>;

  // Revisions
  onRestoreRevision: (revision: NoteRevision) => Promise<void>;
  onCopyRevisionBody: (revision: NoteRevision) => Promise<void>;

  // Dialogs / overlays
  onOpenFolderAccess: (folder: Folder) => void;
  onRequestAIAccess: (target: { kind: 'note'; note: Note; folder: Folder | null }) => void;
  showToast: (msg: string) => void;

  // shadcn dialog hooks (passed through for inline confirm/prompt)
  confirm: Confirm;
  prompt: Prompt;
}

export function NotesEditorView(props: NotesEditorViewProps) {
  const {
    visibleNotes,
    allNotes,
    totalNotes,
    folders,
    tags,
    activeFolder,
    selectedFolderId,
    selectedId,
    selectedNote,
    saveStates,
    editorSyncToken,
    liveRev,
    reviewMcp,
    editorActivityCollapsed,
    setEditorActivityCollapsed,
    paneClass,
    setMobilePane,
    onSelectNote,
    onNewNote,
    onDeleteNote,
    onArchiveNote,
    onUnarchiveNote,
    onDuplicateNote,
    onMoveNote,
    onShareNoteWithLLM,
    onCopyNoteBody,
    onLoadMore,
    onEditNote,
    onUpdateNoteTags,
    onDeleteSelected,
    onShareSelectedWithLLM,
    onCopySelectedBody,
    onDuplicateSelectedNote,
    onMoveSelectedNoteToFolder,
    onCreateTag,
    onRenameFolder,
    onDeleteFolder,
    onArchiveFolder,
    onUnarchiveFolder,
    onDuplicateFolder,
    onMoveFolder,
    onShareFolderWithLLM,
    onChangeFolderViewMode,
    onRestoreRevision,
    onCopyRevisionBody,
    onOpenFolderAccess,
    onRequestAIAccess,
    showToast,
    confirm,
    prompt,
  } = props;

  return (
    <>
      <div className={paneClass('notes')}>
        <NotesList
          notes={visibleNotes}
          folders={folders}
          allTags={tags}
          showFolderBadges={selectedFolderId === undefined}
          folderTitle={
            selectedFolderId === undefined
              ? 'All notes'
              : folders.find((f) => f.id === selectedFolderId)?.name ?? 'Notes'
          }
          folder={activeFolder ?? null}
          onOpenFolderSettings={onOpenFolderAccess}
          onRenameFolder={async (f) => {
            const next = await prompt({
              title: 'Rename folder',
              label: 'Folder name',
              initial: f.name,
              confirmLabel: 'Rename',
            });
            if (next != null) await onRenameFolder(f.id, next);
          }}
          onDuplicateFolder={(f) => void onDuplicateFolder(f.id)}
          onExportFolder={(f) => void exportFolderAsMarkdownZip(f.id, f.name)}
          onMoveFolder={(f, direction) => void onMoveFolder(f.id, direction)}
          onArchiveFolder={async (f) => {
            const ok = await confirm({
              title: `Archive folder "${f.name}"?`,
              description:
                'It will be hidden from lists + search + MCP. You can restore it via "Show Archived" in the gear menu.',
              confirmLabel: 'Archive',
            });
            if (ok) await onArchiveFolder(f.id);
          }}
          onUnarchiveFolder={(f) => void onUnarchiveFolder(f.id)}
          onDeleteFolder={async (f) => {
            const ok = await confirm({
              title: `Delete folder "${f.name}"?`,
              description:
                'Notes inside will become unfiled (move to Trash via the per-note menu first if you want them gone too).',
              confirmLabel: 'Delete folder',
              destructive: true,
            });
            if (ok) await onDeleteFolder(f.id);
          }}
          folderCanMoveUp={
            activeFolder
              ? folders.findIndex((f) => f.id === activeFolder.id) > 0
              : false
          }
          folderCanMoveDown={
            activeFolder
              ? folders.findIndex((f) => f.id === activeFolder.id) < folders.length - 1
              : false
          }
          selectedId={selectedId}
          onSelect={onSelectNote}
          onNewNote={onNewNote}
          onMobileBack={() => setMobilePane('folders')}
          loadedCount={allNotes.length}
          totalCount={totalNotes}
          onLoadMore={onLoadMore}
          onShareFolderWithLLM={
            selectedFolderId !== undefined
              ? () => onShareFolderWithLLM(selectedFolderId)
              : null
          }
          onChangeFolderViewMode={
            activeFolder
              ? (next) => onChangeFolderViewMode(activeFolder, next)
              : null
          }
          onShareNoteWithLLM={onShareNoteWithLLM}
          onCopyNoteBody={onCopyNoteBody}
          onDuplicateNote={onDuplicateNote}
          onMoveNoteToFolder={onMoveNote}
          onDeleteNote={onDeleteNote}
          onArchiveNote={onArchiveNote}
          onUnarchiveNote={onUnarchiveNote}
          onOpenNoteAIAccess={(note) =>
            onRequestAIAccess({
              kind: 'note',
              note,
              folder: folders.find((f) => f.id === note.folderId) ?? null,
            })
          }
          reviewMcp={reviewMcp}
        />
      </div>
      <div className={cn('min-w-0 flex-1', paneClass('editor'))}>
        <EditorPane
          note={selectedNote}
          allTags={tags}
          folders={folders}
          onChange={onEditNote}
          onDelete={onDeleteSelected}
          onArchive={selectedNote ? () => onArchiveNote(selectedNote.id) : undefined}
          onUnarchive={selectedNote ? () => onUnarchiveNote(selectedNote.id) : undefined}
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
          onMobileBack={() => setMobilePane('notes')}
          onRestoreRevision={onRestoreRevision}
          onCopyRevisionBody={onCopyRevisionBody}
          externalSyncToken={editorSyncToken}
          saveState={selectedNote ? saveStates.get(selectedNote.id) ?? 'idle' : 'idle'}
          onImageUploadError={(msg) => showToast(`Image upload failed: ${msg}`)}
          activityToggle={
            selectedNote ? (
              <button
                type="button"
                onClick={() => setEditorActivityCollapsed((v) => !v)}
                aria-label={editorActivityCollapsed ? 'Open activity' : 'Close activity'}
                title="Activity & comments"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-transparent px-2 text-xs text-muted-foreground transition-all hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
              >
                <MessageCircle className="h-3.5 w-3.5" />
              </button>
            ) : undefined
          }
          activityPanel={
            selectedNote ? (
              <NoteRightPanel
                noteId={selectedNote.id}
                noteTitle={selectedNote.title}
                currentActor="user"
                liveRev={liveRev}
                collapsed={editorActivityCollapsed}
                onToggleCollapse={() => setEditorActivityCollapsed((v) => !v)}
                className={editorActivityCollapsed ? '' : 'w-[320px]'}
                onUploadError={(msg) =>
                  showToast(`Comment image upload failed: ${msg}`)
                }
              />
            ) : undefined
          }
        />
      </div>
    </>
  );
}
