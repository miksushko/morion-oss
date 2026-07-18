import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Settings as SettingsIcon, Download } from 'lucide-react';
import { cn } from '../lib/cn';

interface Props {
  /** "Review MCP access" toggle — shown as a checkable menu item. When
   * on, folder/note rows grow compact V/C/E/D perm strips for audit. */
  reviewMcp?: boolean;
  onToggleReviewMcp?: () => void;
  /** "Show Archived" toggle — surfaces archived folders + notes with a
   * muted badge. Persisted by the parent in localStorage. */
  showArchived?: boolean;
  onToggleShowArchived?: () => void;
  /** Open the Import dialog (Phase 1 — markdown). Hidden when omitted. */
  onOpenImport?: () => void;
  /** Open the unified Settings popup (epic 01KPGWTJCWVBQCCSQ8NGSB19KQ).
   *  Phase 5 (this commit) — only entry point for app-wide settings.
   *  Theme / MCP perms / Refresh / Check for updates all live inside
   *  the popup now. */
  onOpenUnifiedSettings: () => void;
}

/**
 * Gear icon button in the sidebar header. Phase 5 of the Settings
 * unification (epic 01KPGWTJCWVBQCCSQ8NGSB19KQ) — menu trimmed to:
 *
 *   - Settings           → opens the unified Settings popup
 *   - Import File        → standalone import flow
 *   - Review MCP access  → toggle for the V/E/D perm-strip overlay
 *   - Show Archived      → toggle for surfacing archived folders/notes
 *
 * Everything else previously in the gear (Theme inline / MCP Settings
 * / Refresh data / Check for updates) moved into the Settings popup
 * tabs.
 *
 * Menu rendering uses `createPortal` to escape the sidebar's overflow
 * context, mirroring the FolderActionsMenu pattern in Sidebar.tsx so
 * the popover doesn't clip when the folder list is long.
 */
export function HeaderMenu({
  reviewMcp,
  onToggleReviewMcp,
  showArchived,
  onToggleShowArchived,
  onOpenImport,
  onOpenUnifiedSettings,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Anchor to the button's bottom-right; the menu uses -translate-x-full to
    // grow to the left so it doesn't overflow the sidebar's right edge.
    setPos({ x: rect.right, y: rect.bottom + 6 });
    setOpen(true);
  };

  // Outside-click + Escape close. Same wiring as FolderActionsMenu.
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

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open settings menu"
        title="Settings"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <SettingsIcon className="h-4 w-4" />
      </button>

      {open && pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-50 min-w-[12rem] -translate-x-full rounded-md border border-border bg-card py-1 text-sm text-foreground shadow-lg"
            style={{ left: pos.x, top: pos.y }}
          >
            {/* Phase 5 (epic 01KPGWTJCWVBQCCSQ8NGSB19KQ) — gear menu
                trimmed to: Settings (opens unified popup) → Import →
                Review MCP / Show Archived toggles. Theme / MCP Settings
                / Refresh data / Check for updates ALL moved into the
                unified Settings popup (General / MCP Server / General →
                Refresh / General → About). */}
            {onOpenUnifiedSettings && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onOpenUnifiedSettings();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent"
              >
                <SettingsIcon className="h-3.5 w-3.5" />
                <span className="flex-1">Settings</span>
              </button>
            )}

            {onOpenImport && (
              <>
                <div className="my-1 border-t border-border" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setOpen(false); onOpenImport(); }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span className="flex-1">Import File</span>
                </button>
              </>
            )}

            {(onToggleReviewMcp || onToggleShowArchived) && (
              <>
                <div className="my-1 border-t border-border" />
                {onToggleReviewMcp && (
                  <div className="flex items-center gap-3 px-3 py-2">
                    <span className="flex-1 text-sm text-foreground">Review MCP access</span>
                    <ToggleSwitch
                      checked={!!reviewMcp}
                      onChange={onToggleReviewMcp}
                      label="Review MCP access"
                    />
                  </div>
                )}
                {onToggleShowArchived && (
                  <div className="flex items-center gap-3 px-3 py-2">
                    <span className="flex-1 text-sm text-foreground">Show Archived</span>
                    <ToggleSwitch
                      checked={!!showArchived}
                      onChange={onToggleShowArchived}
                      label="Show Archived"
                    />
                  </div>
                )}
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        checked ? 'bg-primary' : 'bg-muted',
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-[15px]' : 'translate-x-[1px]',
        )}
      />
    </button>
  );
}

