import { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock } from 'lucide-react';
import { api } from '../../lib/api';
import type {
  AutoCodeQueueRow,
  AutoCodeQueueState,
  AutoCodeWorkflowSummary,
} from '../../lib/api';

/**
 * Per-ticket Auto-code workflow assignment dropdown rendered inside
 * the AutoCodeDrawer header. Lets the user (or any caller of
 * `notes_update({workflowId})`) pin a specific workflow for a
 * single ticket — the resolver consults `notes.workflow_id` first,
 * falling back to the folder's pinned default when null.
 *
 * Ticket 01KRWQPDKQ2RZMDBJZ5KN0B7YE — "Auto-code: make Coding
 * Workflow selectable, before execution".
 *
 * Locked when the ticket has an active run: a workflow swap mid-
 * dispatch would mismatch the immutable graph snapshot the runner
 * loaded at admission time. The user has to drag the card out of
 * `todo` / `doing` first.
 */

const ACTIVE_RUN_STATES: ReadonlySet<AutoCodeQueueState> = new Set([
  'pending',
  'fix_running',
  'fix_review',
  'review_running',
  'paused_ask_user',
]);

export function isLockedDuringRun(runs: readonly AutoCodeQueueRow[]): boolean {
  return runs.some((r) => ACTIVE_RUN_STATES.has(r.state));
}

interface Props {
  taskId: string;
  folderId: string;
  /** Current value of `notes.workflow_id` for this ticket. Null =
   *  "use folder default". */
  currentWorkflowId: string | null;
  runs: readonly AutoCodeQueueRow[];
  /** Fires after a successful PATCH so the parent can refresh its
   *  cached note row. */
  onAssigned?: (workflowId: string | null) => void;
}

const FOLDER_DEFAULT_VALUE = '__folder_default__';

export function WorkflowAssignmentSection({
  taskId,
  folderId,
  currentWorkflowId,
  runs,
  onAssigned,
}: Props) {
  const [workflows, setWorkflows] = useState<AutoCodeWorkflowSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Track an optimistic value separately from `currentWorkflowId` so
  // the dropdown reflects the user's choice immediately. Reverts on
  // PATCH failure.
  const [optimistic, setOptimistic] = useState<string | null>(currentWorkflowId);

  // Keep optimistic state in sync when the parent prop changes (note
  // refetched after a successful save).
  useEffect(() => {
    setOptimistic(currentWorkflowId);
  }, [currentWorkflowId]);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    (async () => {
      try {
        const res = await api.listAutoCodeWorkflows(folderId);
        if (!cancelled) setWorkflows(res.workflows);
      } catch (e) {
        if (!cancelled) {
          setLoadError((e as Error).message ?? String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folderId]);

  const locked = useMemo(() => isLockedDuringRun(runs), [runs]);

  const handleChange = useCallback(
    async (next: string) => {
      const nextWorkflowId =
        next === FOLDER_DEFAULT_VALUE ? null : next;
      const previous = optimistic;
      if (nextWorkflowId === previous) return;
      setOptimistic(nextWorkflowId);
      setSaving(true);
      setSaveError(null);
      try {
        await api.updateNote(taskId, { workflowId: nextWorkflowId });
        onAssigned?.(nextWorkflowId);
      } catch (e) {
        setOptimistic(previous);
        const msg = (e as Error).message ?? String(e);
        setSaveError(parseSaveError(msg));
      } finally {
        setSaving(false);
      }
    },
    [taskId, optimistic, onAssigned],
  );

  // When the stored value points at a workflow that's no longer in
  // the folder's list (deleted between page loads), surface a hint
  // so the user knows their selection was orphaned.
  const orphan = useMemo(() => {
    if (!optimistic) return false;
    // Built-in template ids are also valid; surfaced separately by
    // the backend's workflows_list shape. The summaries endpoint
    // only returns custom rows + seeded template rows; if the
    // stored id isn't a ULID-looking string we assume it's a
    // built-in template (the server-side validator agrees).
    const looksLikeUlid = /^[0-9A-HJKMNP-TV-Z]{26}$/.test(optimistic);
    if (!looksLikeUlid) return false;
    return !workflows.some((w) => w.id === optimistic);
  }, [optimistic, workflows]);

  const value = optimistic ?? FOLDER_DEFAULT_VALUE;

  return (
    <div className="flex flex-col gap-1 border-b border-border bg-card/40 px-4 py-2 text-sm">
      <div className="flex items-center gap-2">
        <label
          htmlFor="auto-code-workflow-select"
          className="shrink-0 text-xs font-medium text-muted-foreground"
        >
          Auto-code workflow
        </label>
        <select
          id="auto-code-workflow-select"
          value={value}
          disabled={locked || saving}
          onChange={(e) => void handleChange(e.target.value)}
          className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value={FOLDER_DEFAULT_VALUE}>
            Use folder default
          </option>
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.isDefault ? '  ·  folder default' : ''}
            </option>
          ))}
          {orphan && optimistic && (
            <option value={optimistic} disabled>
              {optimistic} (deleted)
            </option>
          )}
        </select>
        {locked && (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400"
            title="Workflow is locked while a run is in flight. Drag the card out of todo / doing to change it."
          >
            <Lock className="h-3 w-3" />
            locked
          </span>
        )}
        {saving && (
          <span className="text-[11px] text-muted-foreground">saving…</span>
        )}
      </div>
      {loadError && (
        <div className="text-[11px] text-destructive">{loadError}</div>
      )}
      {saveError && (
        <div className="text-[11px] text-destructive">{saveError}</div>
      )}
      {orphan && !saveError && (
        <div className="text-[11px] text-amber-700 dark:text-amber-400">
          The pinned workflow was deleted. Pick another or fall back to the
          folder default.
        </div>
      )}
    </div>
  );
}

/** Surface the server's structured error envelope in a one-liner the
 *  user can act on. Falls back to the raw message for unknown shapes. */
function parseSaveError(raw: string): string {
  if (raw.includes('workflow_locked_during_run')) {
    return 'This ticket has an active run. Drag the card out of todo / doing first.';
  }
  if (raw.includes('workflow_not_owned_by_folder')) {
    return 'That workflow belongs to a different folder.';
  }
  if (raw.includes('workflow_not_found')) {
    return 'That workflow no longer exists.';
  }
  if (raw.includes('ticket_folder_required')) {
    return 'Per-ticket workflows only apply to notes that live in a folder.';
  }
  return raw;
}
