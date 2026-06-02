import { NotesList } from '../layout/NotesList';
import { EditorPane } from '../layout/EditorPane';
import { cn } from '../lib/cn';
import type { Folder, Note, Tag } from '../lib/api';
import type { MobilePane } from '../appShellTypes';

/**
 * Trash branch: NotesList of soft-deleted notes + EditorPane in read-
 * only mode with Restore / Delete Forever actions. `selectedTrashId`
 * is the trash-scoped selection; switching back to live notes
 * preserves both selections.
 */
export interface TrashViewProps {
  trashedNotes: Note[];
  folders: Folder[];
  tags: Tag[];
  selectedTrashId: string | null;
  selectedNote: Note | null;
  reviewMcp: boolean;

  paneClass: (pane: MobilePane) => string;
  setMobilePane: (pane: MobilePane) => void;

  onSelectNote: (id: string) => void;
  onNewNote: () => void | Promise<void>;
  onShareNoteWithLLM: (id: string) => Promise<void>;
  onCopyNoteBody: (id: string) => Promise<void>;
  onDuplicateNote: (id: string) => Promise<void>;
  onMoveNote: (id: string, target: string | null) => Promise<void>;
  onDeleteNote: (id: string) => Promise<void>;
  onEmptyTrash: () => Promise<void>;

  onEditNote: (patch: { body?: string }) => void;
  onDeleteSelected: () => Promise<void>;
  onCreateTag: (name: string, color: string | null) => Promise<Tag>;
  onShareSelectedWithLLM: () => Promise<void>;
  onCopySelectedBody: () => Promise<void>;
  onDuplicateSelectedNote: () => Promise<void>;
  onMoveSelectedNoteToFolder: (target: string | null) => Promise<void>;
  onRestoreSelected: () => Promise<void>;
  onDeleteForeverSelected: () => Promise<void>;
}

export function TrashView(props: TrashViewProps) {
  const {
    trashedNotes,
    folders,
    tags,
    selectedTrashId,
    selectedNote,
    reviewMcp,
    paneClass,
    setMobilePane,
    onSelectNote,
    onNewNote,
    onShareNoteWithLLM,
    onCopyNoteBody,
    onDuplicateNote,
    onMoveNote,
    onDeleteNote,
    onEmptyTrash,
    onEditNote,
    onDeleteSelected,
    onCreateTag,
    onShareSelectedWithLLM,
    onCopySelectedBody,
    onDuplicateSelectedNote,
    onMoveSelectedNoteToFolder,
    onRestoreSelected,
    onDeleteForeverSelected,
  } = props;

  return (
    <>
      <div className={paneClass('notes')}>
        <NotesList
          notes={trashedNotes}
          folders={folders}
          allTags={tags}
          // Surface the original folder badge so the user can tell
          // where a trashed note used to live before they restore it.
          showFolderBadges
          folderTitle="Trash"
          selectedId={selectedTrashId}
          onSelect={onSelectNote}
          onNewNote={onNewNote}
          onMobileBack={() => setMobilePane('folders')}
          loadedCount={trashedNotes.length}
          totalCount={trashedNotes.length}
          onLoadMore={() => {}}
          onShareFolderWithLLM={null}
          onShareNoteWithLLM={onShareNoteWithLLM}
          onCopyNoteBody={onCopyNoteBody}
          onDuplicateNote={onDuplicateNote}
          onMoveNoteToFolder={onMoveNote}
          onDeleteNote={onDeleteNote}
          trashMode
          onEmptyTrash={onEmptyTrash}
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
          onUpdateTags={() => {}}
          onCreateTag={onCreateTag}
          onShareWithLLM={onShareSelectedWithLLM}
          onCopyBody={onCopySelectedBody}
          onDuplicate={onDuplicateSelectedNote}
          onMoveToFolder={onMoveSelectedNoteToFolder}
          onMobileBack={() => setMobilePane('notes')}
          trashMode
          onRestore={onRestoreSelected}
          onDeleteForever={onDeleteForeverSelected}
        />
      </div>
    </>
  );
}
