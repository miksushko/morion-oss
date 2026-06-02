import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { api } from '../lib/api';
import type {
  AutoCodeWorkflowFull,
  AutoCodeWorkflowSummary,
  ConciergeFolderSettings,
} from '../lib/api';
import { resolveInitialWorkflowId } from './auto-code-popup/select-initial-workflow';
import { Sidebar } from './auto-code-popup/Sidebar';
import { WorkflowPane } from './auto-code-popup/WorkflowPane';

/**
 * Auto-code Workflows popup — full-screen modal hosting the DAG editor
 * for per-folder auto-code workflows. After the Folder/Kanban
 * Settings Unification (Morion note 01KRJN74WV2BE40EJAX7PFN0RE,
 * 2026-05-14) the popup is workflows-only: the folder-level toggle /
 * linked-repo / intake-rule / auto-merge / active-workflow picker
 * surface moved into FolderSettingsDialog's "Auto-code" tab. This
 * popup is opened from there when the user clicks Edit on a workflow
 * row (or "+ New workflow"), because the react-flow canvas needs the
 * full viewport.
 *
 *   - Sidebar: list of available workflows (built-in templates +
 *     per-folder customs). Each row has a more-menu (rename / clone /
 *     delete). "+ New" creates a fresh empty workflow.
 *   - Main pane: visual canvas + JSON escape hatch for the selected
 *     workflow.
 */

type SidebarSelection = { id: string } | null;

interface AutoCodePopupProps {
  folderId: string;
  folderName: string;
  onClose: () => void;
  /** Preselect this workflow on open. When null / omitted, the popup
   *  defaults to the folder's active workflow → first workflow → null
   *  empty state (the "+ New workflow" button is available either
   *  way). */
  initialWorkflowId?: string | null;
  /** Optional — fires when the user mutates anything that the parent
   *  cares about (workflow deleted → server clears `workflowTemplate`
   *  active pointer, parent's "Active workflow" dropdown needs to
   *  resync). */
  onSettingsUpdated?: (next: ConciergeFolderSettings) => void;
}

export function AutoCodePopup({
  folderId,
  folderName,
  onClose,
  initialWorkflowId,
  onSettingsUpdated,
}: AutoCodePopupProps) {
  const [settings, setSettings] = useState<ConciergeFolderSettings | null>(null);
  const [workflows, setWorkflows] = useState<AutoCodeWorkflowSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<SidebarSelection>(
    initialWorkflowId ? { id: initialWorkflowId } : null,
  );
  // Once-only initial selection resolution. After the first load
  // succeeds, if the user hasn't been preselected by the caller AND
  // no row is selected yet, pick the active workflow → first workflow.
  const initialResolvedRef = useRef(false);

  // Initial load — settings + workflows. Templates are no longer
  // a separate UI category (see umbrella spec §J38 + §G27); the
  // server seeds them as editable rows on first list, so a
  // single workflows fetch covers both "shipped defaults" and
  // user-created entries.
  const refreshAll = useCallback(async () => {
    setLoadError(null);
    try {
      const [s, w] = await Promise.all([
        api.getConciergeFolderSettings(folderId),
        api.listAutoCodeWorkflows(folderId),
      ]);
      setSettings(s);
      setWorkflows(w.workflows);
      // First-load default selection — caller may have passed an
      // initialWorkflowId; if not, pick the active workflow then fall
      // back to the first row. Runs once per popup instance.
      if (!initialResolvedRef.current) {
        initialResolvedRef.current = true;
        setSelection((cur) => {
          const picked = resolveInitialWorkflowId(
            cur?.id ?? null,
            s.workflowTemplate ?? '',
            w.workflows,
          );
          return picked ? { id: picked } : null;
        });
      }
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [folderId]);

  const refreshWorkflows = useCallback(async () => {
    try {
      const w = await api.listAutoCodeWorkflows(folderId);
      setWorkflows(w.workflows);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [folderId]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // Esc closes the popup. Earlier comment claimed inputs stop the
  // event from bubbling — that's wrong (Codex P2a round 5,
  // 2026-05-10). Escape DOES bubble from `<input>` / `<textarea>`,
  // and the JSON editor + rename input would lose unsaved edits
  // when the user pressed Esc to deselect a focused field.
  // Skip the close when:
  //   - focus is in a form control (input / textarea / select /
  //     contentEditable) — those have their own Esc semantics
  //     (rename: revert, JSON edit: deselect)
  //   - a child popover/menu is open (data-popup-overlay-open) —
  //     those handle Esc themselves
  useEffect(() => {
    const isFormElementFocused = (target: EventTarget | null): boolean => {
      if (!target || !(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (target.isContentEditable) return true;
      return false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isFormElementFocused(e.target)) return;
      if (document.querySelector('[data-popup-overlay-open="true"]')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Portal to document.body — without this the `fixed inset-0`
  // overlay gets clipped by any ancestor that creates a containing
  // block for fixed descendants (transform / filter / perspective /
  // contain). The app shell's panes use such properties for
  // sticky-header layouts; nesting the popup inside renders a
  // black-on-black "tiny modal" instead of a full-screen overlay.
  // FolderSettingsDialog uses the same portal escape.
  const overlay = (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 p-8 backdrop-blur-sm">
      <div className="flex h-full w-full flex-col rounded-lg border border-border bg-card shadow-2xl">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold">Auto-code Workflows</h2>
            <span className="text-xs text-muted-foreground">— {folderName}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex flex-1 min-h-0">
          <Sidebar
            selection={selection}
            onSelect={setSelection}
            workflows={workflows}
            settings={settings}
            onCreated={async (created) => {
              await refreshWorkflows();
              setSelection({ id: created.id });
            }}
            onWorkflowChanged={refreshWorkflows}
            onWorkflowDeleted={async (deletedId) => {
              // Reset selection if the user deleted the row that was
              // on screen — keeps the main pane from sitting on a 404
              // GET. Also refetch folder settings so the parent's
              // "Active workflow" dropdown resyncs after the server's
              // clear-on-delete (Codex P1b round 5, 2026-05-10).
              if (selection && selection.id === deletedId) {
                setSelection(null);
              }
              try {
                const next = await api.getConciergeFolderSettings(folderId);
                setSettings(next);
                onSettingsUpdated?.(next);
              } catch {
                /* best-effort — sidebar list refresh covers the
                 * primary "row gone" UX */
              }
            }}
            folderId={folderId}
            loadError={loadError}
          />
          <main className="flex flex-1 min-w-0 min-h-0 flex-col p-4">
            {selection ? (
              <WorkflowPane
                workflowId={selection.id}
                onSaved={refreshWorkflows}
                onDeleted={async () => {
                  await refreshWorkflows();
                  setSelection(null);
                }}
                onMissing={async () => {
                  // Row 404'd — server-side sweep removed it after
                  // the sidebar was last rendered. Refresh the list
                  // so the stale entry disappears; WorkflowPane shows
                  // a friendly "no longer exists" state in the main
                  // area until the user picks another row.
                  await refreshWorkflows();
                }}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                {workflows.length === 0
                  ? 'No workflows yet. Click "+ New" in the sidebar to start one.'
                  : 'Select a workflow on the left, or click "+ New".'}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
  return createPortal(overlay, document.body);
}




