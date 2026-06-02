import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  ArchiveRestore,
  Download,
  Files,
  Folder as FolderIcon,
  FolderInput,
  Inbox,
  Lock,
  MoreHorizontal,
  Trash2,
} from 'lucide-react';
import type { Folder } from '../../lib/api';
import { NoteMenuItem } from './NoteMenuItem';

export interface NoteActionsMenuProps {
  noteTitle: string;
  folders: Folder[];
  currentFolderId: string | null;
  isArchived?: boolean;
  onDuplicate: () => Promise<void> | void;
  onMoveToFolder: (folderId: string | null) => Promise<void> | void;
  onOpenAIAccess?: () => void;
  onArchive?: () => Promise<void> | void;
  onUnarchive?: () => Promise<void> | void;
  onDelete: () => void;
  onExport?: () => void;
}

/**
 * Three-dot more-menu attached to the note header. Same portal +
 * outside-click + Escape pattern as Sidebar's `FolderActionsMenu`. Two
 * popovers in one component:
 *
 *   - the menu itself (Duplicate / Move to.../ Delete)
 *   - a `Move to...` picker that opens when the user clicks the Move item
 *
 * They never show at the same time. Anchored relative to the same button.
 */
export function NoteActionsMenu({
  noteTitle,
  folders,
  currentFolderId,
  isArchived,
  onDuplicate,
  onMoveToFolder,
  onOpenAIAccess,
  onArchive,
  onUnarchive,
  onDelete,
  onExport,
}: NoteActionsMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const anchor = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ x: rect.right, y: rect.bottom + 4 });
  };

  const openMenu = () => {
    anchor();
    setPickerOpen(false);
    setMenuOpen(true);
  };

  const openPicker = () => {
    anchor();
    setMenuOpen(false);
    setPickerOpen(true);
  };

  const closeAll = () => {
    setMenuOpen(false);
    setPickerOpen(false);
  };

  useEffect(() => {
    if (!menuOpen && !pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (pickerRef.current?.contains(e.target as Node)) return;
      if (buttonRef.current?.contains(e.target as Node)) return;
      closeAll();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAll();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, pickerOpen]);

  const runAndClose = (fn: () => void | Promise<void>) => () => {
    closeAll();
    void fn();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (menuOpen || pickerOpen) closeAll();
          else openMenu();
        }}
        aria-haspopup="menu"
        aria-expanded={menuOpen || pickerOpen}
        aria-label={`More actions for ${noteTitle}`}
        title="More"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {menuOpen && pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-50 min-w-[10rem] -translate-x-full rounded-md border border-border bg-card py-1 text-sm text-foreground shadow-lg"
            style={{ left: pos.x, top: pos.y }}
          >
            <NoteMenuItem
              icon={<Files className="h-3.5 w-3.5" />}
              label="Duplicate"
              onClick={runAndClose(onDuplicate)}
            />
            <NoteMenuItem
              icon={<FolderInput className="h-3.5 w-3.5" />}
              label="Move to..."
              onClick={() => openPicker()}
            />
            {onExport && (
              <NoteMenuItem
                icon={<Download className="h-3.5 w-3.5" />}
                label="Export to .md"
                onClick={runAndClose(onExport)}
              />
            )}
            {onOpenAIAccess && (
              <NoteMenuItem
                icon={<Lock className="h-3.5 w-3.5" />}
                label="AI Access Permissions"
                onClick={runAndClose(onOpenAIAccess)}
              />
            )}
            <div className="my-1 border-t border-border" />
            {isArchived
              ? onUnarchive && (
                  <NoteMenuItem
                    icon={<ArchiveRestore className="h-3.5 w-3.5" />}
                    label="Unarchive"
                    onClick={runAndClose(onUnarchive)}
                  />
                )
              : onArchive && (
                  <NoteMenuItem
                    icon={<Archive className="h-3.5 w-3.5" />}
                    label="Archive"
                    onClick={runAndClose(onArchive)}
                  />
                )}
            <NoteMenuItem
              icon={<Trash2 className="h-3.5 w-3.5" />}
              label="Delete"
              destructive
              onClick={runAndClose(onDelete)}
            />
          </div>,
          document.body,
        )}
      {pickerOpen && pos &&
        createPortal(
          <div
            ref={pickerRef}
            role="menu"
            className="fixed z-50 max-h-72 w-56 -translate-x-full overflow-y-auto rounded-md border border-border bg-card py-1 text-sm text-foreground shadow-lg"
            style={{ left: pos.x, top: pos.y }}
          >
            <div className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Move to
            </div>
            <NoteMenuItem
              icon={<Inbox className="h-3.5 w-3.5" />}
              label="All notes (unfile)"
              disabled={currentFolderId === null}
              onClick={runAndClose(() => onMoveToFolder(null))}
            />
            {folders.length > 0 && <div className="my-1 border-t border-border" />}
            {folders.map((f) => (
              <NoteMenuItem
                key={f.id}
                icon={<FolderIcon className="h-3.5 w-3.5" />}
                label={f.name}
                disabled={currentFolderId === f.id}
                onClick={runAndClose(() => onMoveToFolder(f.id))}
              />
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
