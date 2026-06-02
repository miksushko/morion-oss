import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Three-dot More menu for a chat — Rename / Archive / Delete collapsed
 * into one button, same shape as NoteActionsMenu. Portal-anchored so it
 * escapes the conversation header's flex clipping.
 */
export function ChatActionsMenu({
  chatTitle,
  isArchived,
  onRename,
  onArchive,
  onDelete,
  size = 'default',
}: {
  chatTitle: string;
  isArchived: boolean;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
  /** 'default' = h-7 w-7 (28px) — used in the conversation header.
   *  'sm' = h-5 w-5 (20px) — used inline in chat list rows so the
   *  row doesn't resize when the menu appears on hover. */
  size?: 'default' | 'sm';
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const anchor = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ x: rect.right, y: rect.bottom + 4 });
  };

  const toggle = () => {
    if (open) {
      setOpen(false);
    } else {
      anchor();
      setOpen(true);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (buttonRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const runAndClose = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${chatTitle}`}
        title="More"
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          size === 'sm' ? 'h-5 w-5' : 'h-7 w-7',
        )}
      >
        <MoreHorizontal className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      </button>
      {open && pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-50 min-w-[10rem] -translate-x-full rounded-md border border-border bg-card py-1 text-sm text-foreground shadow-lg"
            style={{ left: pos.x, top: pos.y }}
          >
            <ChatMenuItem
              icon={<Pencil className="h-3.5 w-3.5" />}
              label="Rename"
              onClick={runAndClose(onRename)}
            />
            <ChatMenuItem
              icon={
                isArchived ? (
                  <ArchiveRestore className="h-3.5 w-3.5" />
                ) : (
                  <Archive className="h-3.5 w-3.5" />
                )
              }
              label={isArchived ? 'Unarchive' : 'Archive'}
              onClick={runAndClose(onArchive)}
            />
            <div className="my-1 border-t border-border" />
            <ChatMenuItem
              icon={<Trash2 className="h-3.5 w-3.5" />}
              label="Delete"
              destructive
              onClick={runAndClose(onDelete)}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

function ChatMenuItem({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'flex w-full items-center gap-2 truncate px-3 py-1.5 text-left transition-colors',
        destructive
          ? 'hover:bg-destructive/10 hover:text-destructive'
          : 'hover:bg-accent',
      )}
    >
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}
