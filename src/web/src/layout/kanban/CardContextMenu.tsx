import {
  Archive,
  ArchiveRestore,
  Copy as CopyIcon,
  Files,
  Folder as FolderIcon,
  FolderInput,
  Inbox,
  Lock,
  Share2,
  Trash2,
} from 'lucide-react';
import type { Folder, Note } from '../../lib/api';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from '../../components/ContextMenu';

export interface CardContextMenuState {
  noteId: string;
  x: number;
  y: number;
  view: 'main' | 'move';
}

export interface CardContextMenuProps {
  state: CardContextMenuState;
  contextNote: Note;
  notes: Note[];
  folders: Folder[];
  onClose: () => void;
  onSetView: (view: 'main' | 'move') => void;
  onShareNoteWithLLM: (id: string) => Promise<void> | void;
  onCopyNoteBody: (id: string) => Promise<void> | void;
  onDuplicateNote: (id: string) => Promise<void> | void;
  onMoveNoteToFolder: (id: string, folderId: string | null) => Promise<void> | void;
  onDeleteNote: (id: string) => Promise<void> | void;
  onArchiveNote?: (id: string) => Promise<void> | void;
  onUnarchiveNote?: (id: string) => Promise<void> | void;
  onOpenNoteAIAccess?: (note: Note) => void;
}

/**
 * Per-card right-click menu. Mirrors NotesList's surface so users get the
 * same actions in list mode and kanban mode. Two views — `main` lists the
 * actions, `move` flips into a folder picker for the "Move to…" branch
 * (re-anchored to the same coordinates so the menu doesn't jump).
 */
export function CardContextMenu({
  state,
  contextNote,
  notes,
  folders,
  onClose,
  onSetView,
  onShareNoteWithLLM,
  onCopyNoteBody,
  onDuplicateNote,
  onMoveNoteToFolder,
  onDeleteNote,
  onArchiveNote,
  onUnarchiveNote,
  onOpenNoteAIAccess,
}: CardContextMenuProps) {
  return (
    <ContextMenu
      x={state.x}
      y={state.y}
      onClose={onClose}
      ariaLabel={`Actions for card ${contextNote.title || 'Untitled'}`}
    >
      {state.view === 'main' ? (
        <>
          <ContextMenuItem
            icon={<Share2 className="h-3.5 w-3.5" />}
            label="Share with LLM"
            onClick={() => {
              const id = state.noteId;
              onClose();
              void onShareNoteWithLLM(id);
            }}
          />
          <ContextMenuItem
            icon={<CopyIcon className="h-3.5 w-3.5" />}
            label="Copy body"
            onClick={() => {
              const id = state.noteId;
              onClose();
              void onCopyNoteBody(id);
            }}
          />
          {onOpenNoteAIAccess && (
            <ContextMenuItem
              icon={<Lock className="h-3.5 w-3.5" />}
              label="AI Access Permissions"
              onClick={() => {
                const id = state.noteId;
                onClose();
                const n = notes.find((x) => x.id === id);
                if (n) onOpenNoteAIAccess(n);
              }}
            />
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<Files className="h-3.5 w-3.5" />}
            label="Duplicate"
            onClick={() => {
              const id = state.noteId;
              onClose();
              void onDuplicateNote(id);
            }}
          />
          <ContextMenuItem
            icon={<FolderInput className="h-3.5 w-3.5" />}
            label="Move to..."
            onClick={() => onSetView('move')}
          />
          <ContextMenuSeparator />
          {contextNote.archivedAt == null
            ? onArchiveNote && (
                <ContextMenuItem
                  icon={<Archive className="h-3.5 w-3.5" />}
                  label="Archive"
                  onClick={() => {
                    const id = state.noteId;
                    onClose();
                    void onArchiveNote(id);
                  }}
                />
              )
            : onUnarchiveNote && (
                <ContextMenuItem
                  icon={<ArchiveRestore className="h-3.5 w-3.5" />}
                  label="Unarchive"
                  onClick={() => {
                    const id = state.noteId;
                    onClose();
                    void onUnarchiveNote(id);
                  }}
                />
              )}
          <ContextMenuItem
            icon={<Trash2 className="h-3.5 w-3.5" />}
            label="Delete"
            destructive
            onClick={() => {
              const id = state.noteId;
              onClose();
              void onDeleteNote(id);
            }}
          />
        </>
      ) : (
        <>
          <ContextMenuLabel>Move to</ContextMenuLabel>
          <ContextMenuItem
            icon={<Inbox className="h-3.5 w-3.5" />}
            label="All notes (unfile)"
            disabled={contextNote.folderId === null}
            onClick={() => {
              const id = state.noteId;
              onClose();
              void onMoveNoteToFolder(id, null);
            }}
          />
          {folders.length > 0 && <ContextMenuSeparator />}
          {folders.map((f) => (
            <ContextMenuItem
              key={f.id}
              icon={<FolderIcon className="h-3.5 w-3.5" />}
              label={f.name}
              disabled={contextNote.folderId === f.id}
              onClick={() => {
                const id = state.noteId;
                onClose();
                void onMoveNoteToFolder(id, f.id);
              }}
            />
          ))}
        </>
      )}
    </ContextMenu>
  );
}
