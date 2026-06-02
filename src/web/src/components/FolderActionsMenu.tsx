import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  Folder as FolderIcon,
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  Share2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { FolderViewMode } from '../lib/api';
import { cn } from '../lib/cn';

/**
 * Three-dot more-menu carrying every per-folder operation.
 *
 * Originally lived inside `Sidebar.tsx` attached to each folder row in
 * the folder tree (folder-row trigger only visible on hover). Extracted
 * 2026-05-06 (ticket `01KQXZJX3KSY32B7J9HZNGZ9T2`) when the same menu
 * was needed at the top of the NotesList header. Both call sites pass
 * the same operation callbacks; the only difference is whether the
 * trigger is hover-gated (folder tree) or always visible (notes
 * header).
 *
 * Renders the menu in a portal anchored by `position: fixed` so it
 * escapes any scroll-clipping ancestor. Closes on outside-click or
 * Escape (same pattern as TagPicker / ChatActionsMenu).
 *
 * Trigger button is built-in. Pass `triggerClassName` to override
 * visibility / sizing (the folder tree wants `hidden group-hover:
 * inline-flex`; the notes header wants always-visible).
 */
export interface FolderActionsMenuProps {
  folderName: string;
  viewMode: FolderViewMode;
  canMoveUp: boolean;
  canMoveDown: boolean;
  isArchived: boolean;
  onRename: () => void;
  onDuplicate: () => void;
  onShareWithLLM: () => void;
  /** Open the unified per-folder settings popup (AI Access / Mo
   * Workflow / Mo Project Memory tabs). */
  onOpenSettings: () => void;
  onSwitchViewMode: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  /** Download the folder as a `.zip` of `.md` files. */
  onExport: () => void;
  onArchive?: () => Promise<void> | void;
  onUnarchive?: () => Promise<void> | void;
  onDelete: () => Promise<void> | void;
  /** Override the trigger button's class. Default targets the
   *  hover-gated folder-tree row. NotesList header passes an
   *  always-visible class. */
  triggerClassName?: string;
}

export function FolderActionsMenu({
  folderName,
  viewMode,
  canMoveUp,
  canMoveDown,
  isArchived,
  onRename,
  onDuplicate,
  onShareWithLLM,
  onOpenSettings,
  onSwitchViewMode,
  onMoveUp,
  onMoveDown,
  onExport,
  onArchive,
  onUnarchive,
  onDelete,
  triggerClassName,
}: FolderActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    x: number;
    y: number;
    placement: 'below' | 'above';
    /** Horizontal anchor: 'right' = menu's right edge sits at the
     * button's right edge growing leftward (default; matches the
     * narrow sidebar pane). 'left' = grows rightward when the menu
     * would overflow the left viewport edge. */
    horizontal: 'right' | 'left';
  } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = (): void => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Estimate menu height so we can flip-up when near the viewport
    // bottom. Menu has ~11 items + 2 dividers + py-1 padding. Row
    // height varies slightly (icon vs text) but averages ~32px.
    // Conservative constant avoids measuring after render (which
    // would flicker). If the menu grows past this budget in a future
    // redesign, bump the constant — the flip is permissive, never
    // incorrect.
    const ESTIMATED_MENU_HEIGHT = 380;
    // Menu's longest label is "Switch to Kanban" / "Folder Settings"
    // — fits comfortably in ~15rem (240px). Conservative buffer brings
    // this to 260px; only used to detect viewport overflow before
    // render. Keep in sync with the `min-w-[15rem]` class below.
    const ESTIMATED_MENU_WIDTH = 260;
    const VIEWPORT_MARGIN = 12;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < ESTIMATED_MENU_HEIGHT + VIEWPORT_MARGIN;
    // Default: anchor at button's RIGHT edge growing left (`-translate-x-full`).
    // If that would push the menu past the left viewport edge — typical
    // when the sidebar is narrow — anchor at button's LEFT edge growing right.
    const overflowLeft = rect.right - ESTIMATED_MENU_WIDTH < VIEWPORT_MARGIN;
    setPos({
      x: overflowLeft ? rect.left : rect.right,
      y: flipUp ? rect.top - 4 : rect.bottom + 4,
      placement: flipUp ? 'above' : 'below',
      horizontal: overflowLeft ? 'left' : 'right',
    });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (buttonRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (open) setOpen(false);
          else openMenu();
        }}
        className={cn(
          'shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          triggerClassName ??
            // Default: folder-tree row trigger — hidden until row hover,
            // always visible on touch devices (where there's no hover).
            'p-1 hidden group-hover:inline-flex [@media(hover:none)]:inline-flex',
        )}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${folderName}`}
        title="More"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className={cn(
              // Width sized to fit the longest label ("Switch to
              // Kanban" / "Folder Settings" + icon) without
              // truncation.
              'fixed z-50 min-w-[15rem] rounded-md border border-border bg-card py-1 text-sm text-foreground shadow-lg',
              // Horizontal anchor — see openMenu(). Default anchors the
              // menu's right edge at the button's right edge (sidebar is
              // narrow; menu grows left). When that would overflow the
              // left viewport edge, we drop the translate so the menu
              // grows rightward from the button's left edge instead.
              pos.horizontal === 'right' && '-translate-x-full',
              // When flipping up, CSS translates the menu to sit ABOVE
              // its anchor point.
              pos.placement === 'above' && '-translate-y-full',
            )}
            style={{ left: pos.x, top: pos.y }}
          >
            {/* Section: action. */}
            <MenuItem
              icon={<Share2 className="h-3.5 w-3.5" />}
              label="Share Folder with LLM"
              onClick={run(onShareWithLLM)}
            />
            <div className="my-1 border-t border-border" />
            {/* Section: settings — single entry to the unified popup. */}
            <MenuItem
              icon={<Sparkles className="h-3.5 w-3.5" />}
              label="Folder Settings"
              onClick={run(onOpenSettings)}
            />
            <div className="my-1 border-t border-border" />
            {/* Section: view — single switch (room for calendar later). */}
            <MenuItem
              icon={
                viewMode === 'kanban' ? (
                  <FolderIcon className="h-3.5 w-3.5" />
                ) : (
                  <LayoutGrid className="h-3.5 w-3.5" />
                )
              }
              label={viewMode === 'kanban' ? 'Switch to List' : 'Switch to Kanban'}
              onClick={run(onSwitchViewMode)}
            />
            <div className="my-1 border-t border-border" />
            {/* Section: folder ops. */}
            <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} label="Rename" onClick={run(onRename)} />
            <MenuItem icon={<Copy className="h-3.5 w-3.5" />} label="Duplicate" onClick={run(onDuplicate)} />
            <MenuItem
              icon={<Download className="h-3.5 w-3.5" />}
              label="Export to .md"
              onClick={run(onExport)}
            />
            <MenuItem
              icon={<ArrowUp className="h-3.5 w-3.5" />}
              label="Move up"
              disabled={!canMoveUp}
              onClick={run(onMoveUp)}
            />
            <MenuItem
              icon={<ArrowDown className="h-3.5 w-3.5" />}
              label="Move down"
              disabled={!canMoveDown}
              onClick={run(onMoveDown)}
            />
            <div className="my-1 border-t border-border" />
            {/* Section: destructive. */}
            {isArchived
              ? onUnarchive && (
                  <MenuItem
                    icon={<ArchiveRestore className="h-3.5 w-3.5" />}
                    label="Unarchive"
                    onClick={run(onUnarchive)}
                  />
                )
              : onArchive && (
                  <MenuItem
                    icon={<Archive className="h-3.5 w-3.5" />}
                    label="Archive"
                    onClick={run(onArchive)}
                  />
                )}
            <MenuItem
              icon={<Trash2 className="h-3.5 w-3.5" />}
              label="Delete"
              destructive
              onClick={run(onDelete)}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
        disabled && 'cursor-not-allowed opacity-40',
        !disabled && (destructive ? 'hover:bg-destructive/10 hover:text-destructive' : 'hover:bg-accent'),
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
    </button>
  );
}
