import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, type AutoCodeWorkflowSummary } from '../../../lib/api';
import { EMPTY_DEFINITION } from '../../auto-code-popup/empty-definition';
import { WorkflowRow } from './WorkflowRow';

/** Folder Auto-code Workflows — list of every workflow available in
 *  this folder. No DAG preview here (that lives in the Workflows
 *  popup); each row shows the name + status badges + an Edit button
 *  that opens the full-screen Workflows popup focused on that row.
 *  "+ New workflow" creates one and opens the popup for editing. */
export function FolderWorkflowsSection({
  folderId,
  onOpenWorkflowsPopup,
  disabled,
}: {
  folderId: string;
  onOpenWorkflowsPopup?: (workflowId: string | null) => void;
  disabled: boolean;
}) {
  const [workflows, setWorkflows] = useState<AutoCodeWorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const w = await api.listAutoCodeWorkflows(folderId);
      setWorkflows(w.workflows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [folderId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // "+ New workflow" — create a fresh empty workflow via API, then
  // open the popup focused on it so the user lands in the editor
  // immediately. Without the create step the popup falls back to the
  // folder's active workflow and the user mistakes that for the "new"
  // they asked for (ticket 01KRYBVTKJ56A6KE93Y09VXG4E).
  const handleNew = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const created = await api.createAutoCodeWorkflow({
        folderId,
        name: 'New workflow',
        definition: EMPTY_DEFINITION,
      });
      void refresh();
      onOpenWorkflowsPopup?.(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }, [folderId, onOpenWorkflowsPopup, refresh]);

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-[12px] font-medium">
            Folder Auto-code Workflows
          </div>
          <p className="text-[11px] text-muted-foreground">
            Workflows available in this folder. Click <em>Edit</em> to
            tune the DAG in the full-screen editor.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleNew()}
          disabled={disabled || creating}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-accent disabled:opacity-50"
        >
          <Plus className="h-3 w-3" /> New workflow
        </button>
      </div>

      {loading ? (
        <div className="rounded-md border border-border bg-background/40 p-3 text-center text-xs text-muted-foreground">
          Loading workflows…
        </div>
      ) : workflows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-background/20 p-3 text-xs italic text-muted-foreground">
          No workflows yet. Click "+ New workflow" to start one.
        </p>
      ) : (
        <ul className="rounded-md border border-border bg-background/40 divide-y divide-border">
          {workflows.map((w) => (
            <WorkflowRow
              key={w.id}
              workflow={w}
              disabled={disabled}
              onEdit={() => onOpenWorkflowsPopup?.(w.id)}
              onChanged={refresh}
            />
          ))}
        </ul>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </section>
  );
}
