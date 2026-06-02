import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';

interface Props {
  /** Cursor position in viewport coordinates (e.clientX/clientY). */
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
  ariaLabel?: string;
}

/**
 * Context menu primitive. Renders into a portal anchored at the cursor and
 * clamps itself to the viewport edges via useLayoutEffect (no flash because
 * the clamp runs after the DOM update but before the browser paints). Closes
 * on outside mousedown or Escape; the parent owns the open/closed state and
 * the (x, y) anchor.
 *
 * Used by Sidebar (right-click on a folder row) and NotesList (right-click on
 * a note row). Mirrors the existing FolderActionsMenu / NoteActionsMenu items
 * — same actions, different trigger.
 */
export function ContextMenu({ x, y, onClose, children, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Imperatively clamp the menu inside the viewport. We mutate `style.left/top`
  // directly instead of going through state so the measurement and the final
  // position land in the same paint — no visible flash near the edges.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (nx + rect.width > vw - 4) nx = Math.max(4, vw - rect.width - 4);
    if (ny + rect.height > vh - 4) ny = Math.max(4, vh - rect.height - 4);
    el.style.left = `${nx}px`;
    el.style.top = `${ny}px`;
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      // Suppress the OS context menu when the user right-clicks inside the menu
      // itself — otherwise hitting "Move to..." with the right mouse button
      // would close ours and pop up Chrome's native menu on top.
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 min-w-[12rem] rounded-md border border-border bg-card py-1 text-sm text-foreground shadow-lg"
      style={{ left: x, top: y }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function ContextMenuItem({
  icon,
  label,
  onClick,
  disabled,
  destructive,
}: {
  icon: ReactNode;
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
        !disabled &&
          (destructive
            ? 'hover:bg-destructive/10 hover:text-destructive'
            : 'hover:bg-accent'),
      )}
      title={label}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

export function ContextMenuSeparator() {
  return <div className="my-1 border-t border-border" />;
}

export function ContextMenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}
