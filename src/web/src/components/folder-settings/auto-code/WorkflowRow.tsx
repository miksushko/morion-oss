import { useEffect, useRef, useState } from 'react';
import { MoreVertical, Workflow } from 'lucide-react';

import { api, type AutoCodeWorkflowSummary } from '../../../lib/api';
import { nextCloneName } from './clone-name';

/**
 * One row in the folder-settings Auto-code → Workflows list. Owns
 * the More menu (Make Default / Rename / Clone / Delete) + inline
 * rename + delete-confirm. Mirrors AutoCodePopup's SidebarWorkflowItem
 * but adds Make Default (popup sidebar doesn't have it) and uses the
 * `(Copy)` / `(Copy 2)` naming from clone-name.ts instead of the
 * server clone endpoint's lowercase "(copy)".
 *
 * Parent (FolderWorkflowsSection) owns the list + refresh callback.
 *
 * Ticket: 01KRYBG9N6HMQG308ZTSQSMMND
 */
export function WorkflowRow({
  workflow,
  disabled,
  onEdit,
  onChanged,
}: {
  workflow: AutoCodeWorkflowSummary;
  disabled: boolean;
  onEdit: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(workflow.name);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const next = draftName.trim();
    if (next === '' || next === workflow.name) {
      setRenaming(false);
      setDraftName(workflow.name);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateAutoCodeWorkflow(workflow.id, { name: next });
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
      setDraftName(workflow.name);
    } finally {
      setBusy(false);
      setRenaming(false);
    }
  };

  const onMakeDefault = async () => {
    setMenuOpen(false);
    setBusy(true);
    setError(null);
    try {
      await api.updateAutoCodeWorkflow(workflow.id, { isDefault: true });
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Path B clone: fetch source for its full definition, compute the
  // next "(Copy N)" name locally, POST a new workflow. One round trip
  // worse than the server's clone endpoint, but server's endpoint
  // hardcodes lowercase "(copy)" — and we want the (Copy) / (Copy 2)
  // shape spec'd by the ticket.
  const onClone = async () => {
    setMenuOpen(false);
    setBusy(true);
    setError(null);
    try {
      const full = await api.getAutoCodeWorkflow(workflow.id);
      await api.createAutoCodeWorkflow({
        folderId: full.folderId,
        name: nextCloneName(full.name),
        definition: full.definition,
      });
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAutoCodeWorkflow(workflow.id);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setConfirmDelete(false);
      setMenuOpen(false);
    }
  };

  return (
    <li ref={wrapRef} className="relative flex items-center gap-2.5 p-2.5">
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
        <Workflow className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
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
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] font-medium text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12px] font-medium text-foreground">
              {workflow.name}
            </span>
            {workflow.isDefault && (
              <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-primary">
                default
              </span>
            )}
          </div>
        )}
        {error && (
          <div className="mt-0.5 truncate text-[10px] text-destructive" title={error}>
            {error}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onEdit}
        disabled={disabled || busy || renaming}
        className="shrink-0 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground hover:bg-accent disabled:opacity-50"
      >
        Edit
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        disabled={disabled || busy || renaming}
        aria-label="More"
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>
      {menuOpen && !confirmDelete && (
        <div
          data-popup-overlay-open="true"
          className="absolute right-2 top-full z-20 mt-1 w-44 rounded-md border border-border bg-popover py-1 text-[11px] shadow-md"
        >
          <button
            type="button"
            onClick={() => void onMakeDefault()}
            disabled={workflow.isDefault || busy}
            title={workflow.isDefault ? 'Already the default workflow' : undefined}
            className="block w-full px-3 py-1.5 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          >
            Make default
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setRenaming(true);
              setDraftName(workflow.name);
            }}
            disabled={busy}
            className="block w-full px-3 py-1.5 text-left hover:bg-accent disabled:opacity-50"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => void onClone()}
            disabled={busy}
            className="block w-full px-3 py-1.5 text-left hover:bg-accent disabled:opacity-50"
          >
            Clone
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={workflow.isDefault || busy}
            title={
              workflow.isDefault
                ? 'Assign another workflow as default first'
                : undefined
            }
            className="block w-full px-3 py-1.5 text-left text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          >
            Delete
          </button>
        </div>
      )}
      {confirmDelete && (
        <div
          data-popup-overlay-open="true"
          className="absolute right-2 top-full z-20 mt-1 w-56 rounded-md border border-destructive/50 bg-popover p-2 text-[11px] shadow-md"
        >
          <p className="mb-2 text-destructive">
            Delete &quot;{workflow.name}&quot;?
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
    </li>
  );
}
