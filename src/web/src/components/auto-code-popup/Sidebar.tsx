import { useState } from 'react';

import { api } from '../../lib/api';
import type {
  AutoCodeWorkflowFull,
  AutoCodeWorkflowSummary,
  ConciergeFolderSettings,
} from '../../lib/api';

import { EMPTY_DEFINITION } from './empty-definition';
import { resolveActiveWorkflowId } from './select-initial-workflow';
import { SidebarWorkflowItem } from './SidebarWorkflowItem';

/**
 * Sidebar of the AutoCode popup — list of workflows (built-in templates
 * + per-folder customs, all editable rows after seeding) + the "+ New"
 * action that creates a fresh workflow from EMPTY_DEFINITION.
 *
 * Extracted from AutoCodePopup.tsx 2026-05-16 (Morion ticket
 * 01KRJZ2FW12N262K6AFD7TC93K).
 */

type SidebarSelection = { id: string } | null;

export function Sidebar({
  selection,
  onSelect,
  workflows,
  settings,
  onCreated,
  onWorkflowChanged,
  onWorkflowDeleted,
  folderId: _folderId,
  loadError,
}: {
  selection: SidebarSelection;
  onSelect: (s: SidebarSelection) => void;
  workflows: AutoCodeWorkflowSummary[];
  settings: ConciergeFolderSettings | null;
  onCreated: (created: AutoCodeWorkflowFull) => void | Promise<void>;
  onWorkflowChanged: () => void | Promise<void>;
  /** Fired AFTER a sidebar-driven delete completes. Lets the parent
   *  reset selection AND refetch folder settings (the delete route
   *  clears the active-workflow KV when it pointed at the deleted
   *  row). */
  onWorkflowDeleted: (deletedId: string) => void | Promise<void>;
  folderId: string;
  loadError: string | null;
}) {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Resolve the active workflow id with the same fallback chain
  // SettingsPane uses (stored ULID match → isDefault row → first
  // row). Keeps the sidebar's "active" badge in sync with the
  // dropdown when the stored setting is a legacy registry id.
  const activeId = resolveActiveWorkflowId(
    settings?.workflowTemplate ?? '',
    workflows,
  );

  const onCreate = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.createAutoCodeWorkflow({
        folderId,
        name: 'New workflow',
        definition: EMPTY_DEFINITION,
      });
      await onCreated(created);
    } catch (e) {
      setCreateError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-background/40">
      <div className="flex flex-1 flex-col overflow-y-auto py-2">
        <div className="mb-3 flex items-center justify-between px-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Workflows</span>
          <button
            type="button"
            onClick={() => void onCreate()}
            disabled={creating}
            className="rounded-md border border-border bg-background px-2 py-0.5 text-[10px] normal-case text-foreground hover:bg-accent disabled:opacity-50"
          >
            + New
          </button>
        </div>
        {createError && (
          <div className="mx-3 mb-2 rounded-md border border-destructive/50 bg-destructive/10 p-1.5 text-[10px] text-destructive">
            {createError}
          </div>
        )}
        {workflows.length === 0 && (
          <div className="px-3 py-1 text-[10px] italic text-muted-foreground">
            Setting up default workflows…
          </div>
        )}
        {workflows.map((w) => (
          <SidebarWorkflowItem
            key={w.id}
            workflow={w}
            active={selection !== null && selection.id === w.id}
            isFolderActive={activeId === w.id}
            onClick={() => onSelect({ id: w.id })}
            onChanged={onWorkflowChanged}
            onDeleted={onWorkflowDeleted}
          />
        ))}
        {loadError && (
          <div className="mx-3 my-1 rounded-md border border-destructive/50 bg-destructive/10 p-1.5 text-[10px] text-destructive">
            {loadError}
          </div>
        )}
      </div>
    </aside>
  );
}
