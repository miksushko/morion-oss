import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Folder as FolderIcon,
  FolderInput,
  Inbox,
  Trash2,
  X as XIcon,
} from 'lucide-react';
import type { Folder } from '../../lib/api';

/**
 * ClickUp-style floating toolbar anchored to the bottom of the kanban
 * viewport. Only rendered when the user has at least one card selected
 * inside select mode. Left-side count + clear (X), right-side action
 * buttons (Move to + Delete). Delete goes through `useConfirm()` at the
 * parent so the destructive action still needs explicit intent.
 */
export function BulkActionBar({
  count,
  folders,
  currentFolderId,
  onMoveTo,
  onDelete,
  onArchive,
  onUnarchive,
  archiveCount,
  unarchiveCount,
  onClear,
}: {
  count: number;
  folders: Folder[];
  currentFolderId: string | null;
  onMoveTo: (folderId: string | null) => void | Promise<void>;
  onDelete: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  archiveCount: number;
  unarchiveCount: number;
  onClear: () => void;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const moveButtonRef = useRef<HTMLButtonElement | null>(null);

  // Close the move picker on outside click / Escape.
  useEffect(() => {
    if (!moveOpen) return;
    const handlePointer = (e: MouseEvent) => {
      if (moveButtonRef.current?.contains(e.target as Node)) return;
      const popover = document.getElementById('bulk-move-popover');
      if (popover?.contains(e.target as Node)) return;
      setMoveOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoveOpen(false);
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [moveOpen]);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center"
      role="toolbar"
      aria-label="Bulk actions"
    >
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-primary/60 bg-primary px-2 py-1.5 text-primary-foreground shadow-xl ring-1 ring-primary/40">
        <span className="inline-flex items-center gap-2 rounded-full bg-primary-foreground/15 px-3 py-1 text-xs font-medium">
          <span className="tabular-nums">{count}</span>
          <span className="opacity-80">selected</span>
          <button
            type="button"
            onClick={onClear}
            className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-primary-foreground/80 hover:bg-primary-foreground/20 hover:text-primary-foreground"
            aria-label="Clear selection"
            title="Clear selection"
          >
            <XIcon className="h-3 w-3" />
          </button>
        </span>

        <div className="mx-1 h-5 w-px bg-primary-foreground/30" aria-hidden />

        <div className="relative">
          <button
            ref={moveButtonRef}
            type="button"
            onClick={() => setMoveOpen((v) => !v)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary-foreground/15"
            aria-haspopup="menu"
            aria-expanded={moveOpen}
          >
            <FolderInput className="h-3.5 w-3.5" />
            Move to
          </button>
          {moveOpen && (
            <div
              id="bulk-move-popover"
              role="menu"
              className="absolute bottom-full left-0 mb-2 max-h-80 w-56 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-xl"
            >
              <button
                type="button"
                role="menuitem"
                onClick={async () => {
                  setMoveOpen(false);
                  await onMoveTo(null);
                }}
                disabled={currentFolderId === null}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Inbox className="h-3.5 w-3.5" />
                All notes (unfile)
              </button>
              {folders.length > 0 && (
                <div className="my-1 h-px bg-border" aria-hidden />
              )}
              {folders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="menuitem"
                  onClick={async () => {
                    setMoveOpen(false);
                    await onMoveTo(f.id);
                  }}
                  disabled={currentFolderId === f.id}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <FolderIcon className="h-3.5 w-3.5" />
                  <span className="truncate">{f.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {onArchive && (
          <button
            type="button"
            onClick={onArchive}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary-foreground/15"
            title={
              unarchiveCount > 0
                ? `Archive ${archiveCount} of ${archiveCount + unarchiveCount}`
                : 'Archive selected'
            }
          >
            <Archive className="h-3.5 w-3.5" />
            Archive{unarchiveCount > 0 ? ` (${archiveCount})` : ''}
          </button>
        )}

        {onUnarchive && (
          <button
            type="button"
            onClick={onUnarchive}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary-foreground/15"
            title={
              archiveCount > 0
                ? `Unarchive ${unarchiveCount} of ${archiveCount + unarchiveCount}`
                : 'Unarchive selected'
            }
          >
            <ArchiveRestore className="h-3.5 w-3.5" />
            Unarchive{archiveCount > 0 ? ` (${unarchiveCount})` : ''}
          </button>
        )}

        <button
          type="button"
          onClick={onDelete}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary-foreground/15"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
      </div>
    </div>
  );
}
