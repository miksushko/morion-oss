import { useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';

import { api } from '../../lib/api';
import type { AutoCodeWorkflowSummary } from '../../lib/api';
import { cn } from '../../lib/cn';

/**
 * Sidebar row for the AutoCode popup workflow list. Owns its own
 * rename / clone / delete affordances (More menu → confirm sub-popover).
 * Parent (Sidebar) forwards `onChanged` to trigger a list refresh and
 * `onDeleted(id)` so the popup can reset selection and refetch folder
 * settings (delete-clears-active-template cascade).
 *
 * Extracted from AutoCodePopup.tsx 2026-05-16 (Morion ticket
 * 01KRJZ2FW12N262K6AFD7TC93K).
 */

export function SidebarWorkflowItem({
  workflow,
  active,
  isFolderActive,
  onClick,
  onChanged,
  onDeleted,
}: {
  workflow: AutoCodeWorkflowSummary;
  active?: boolean;
  isFolderActive?: boolean;
  onClick: () => void;
  onChanged: () => void | Promise<void>;
  onDeleted: (deletedId: string) => void | Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(workflow.name);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Click-outside to close menu.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  const onRenameSave = async () => {
    if (draftName.trim() === '' || draftName === workflow.name) {
      setRenaming(false);
      setDraftName(workflow.name);
      return;
    }
    setBusy(true);
    try {
      await api.updateAutoCodeWorkflow(workflow.id, { name: draftName.trim() });
      await onChanged();
    } catch (e) {
      setDraftName(workflow.name);
      console.error('rename failed', e);
    } finally {
      setBusy(false);
      setRenaming(false);
    }
  };

  const onClone = async () => {
    setBusy(true);
    setMenuOpen(false);
    try {
      await api.cloneAutoCodeWorkflow(workflow.id);
      await onChanged();
    } catch (e) {
      console.error('clone failed', e);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    setBusy(true);
    try {
      await api.deleteAutoCodeWorkflow(workflow.id);
      await onDeleted(workflow.id);
      await onChanged();
    } catch (e) {
      console.error('delete failed', e);
    } finally {
      setBusy(false);
      setConfirmDelete(false);
      setMenuOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <div
        className={cn(
          'group mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
          active
            ? 'bg-primary/15 text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <button
          type="button"
          onClick={onClick}
          className="flex flex-1 min-w-0 flex-col items-start text-left"
          disabled={renaming}
        >
          {renaming ? (
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => void onRenameSave()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onRenameSave();
                if (e.key === 'Escape') {
                  setDraftName(workflow.name);
                  setRenaming(false);
                }
              }}
              disabled={busy}
              className="w-full rounded border border-border bg-background px-1 py-0.5 text-[12px] text-foreground outline-none"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="block w-full truncate text-[12px] font-medium">
              {workflow.name}
            </span>
          )}
          <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
            {workflow.agentChain.join(' → ') || `${workflow.stageCount} stages`}
          </span>
        </button>
        {workflow.isDefault && (
          <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-primary">
            default
          </span>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="More"
        >
          <MoreVertical className="h-3 w-3" />
        </button>
      </div>
      {menuOpen && !confirmDelete && (
        <div
          data-popup-overlay-open="true"
          className="absolute right-2 top-full z-10 mt-1 w-40 rounded-md border border-border bg-popover py-1 text-[11px] shadow-md"
        >
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setRenaming(true);
              setDraftName(workflow.name);
            }}
            className="block w-full px-3 py-1.5 text-left hover:bg-accent"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => void onClone()}
            className="block w-full px-3 py-1.5 text-left hover:bg-accent"
            disabled={busy}
          >
            Clone
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="block w-full px-3 py-1.5 text-left text-destructive hover:bg-destructive/10"
            disabled={busy}
          >
            Delete
          </button>
        </div>
      )}
      {confirmDelete && (
        <div
          data-popup-overlay-open="true"
          className="absolute right-2 top-full z-10 mt-1 w-48 rounded-md border border-destructive/50 bg-popover p-2 text-[11px] shadow-md"
        >
          <p className="mb-2 text-destructive">
            Delete "{workflow.name}"?
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirmDelete(false);
                setMenuOpen(false);
              }}
              className="rounded border border-border bg-background px-2 py-0.5 hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onDelete()}
              disabled={busy}
              className="rounded border border-destructive bg-destructive px-2 py-0.5 text-destructive-foreground hover:opacity-90 disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
