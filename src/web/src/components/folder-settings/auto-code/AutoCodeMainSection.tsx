import { useEffect, useRef, useState } from 'react';
import {
  api,
  type AutoCodeWorkflowResolution,
  type AutoCodeWorkflowSummary,
  type ConciergeFolderSettings,
} from '../../../lib/api';
import { isTauri } from '../../../lib/env';
import { SwitchRow } from '../../SwitchRow';
import { WorkflowDropdown } from './WorkflowDropdown';

/** Master toggle + linked-repo input + active-workflow picker.
 *  Mirrors the per-folder controls that used to live in the standalone
 *  AutoCodePopup's SettingsPane. */
export function AutoCodeMainSection({
  folderId,
  settings,
  onSettingsChange,
  moEnabled,
  disabled,
}: {
  folderId: string;
  settings: ConciergeFolderSettings;
  onSettingsChange: (next: ConciergeFolderSettings) => void;
  moEnabled: boolean;
  disabled: boolean;
}) {
  const [pathDraft, setPathDraft] = useState(settings.linkedRepoPath ?? '');
  const [savingPath, setSavingPath] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<AutoCodeWorkflowSummary[]>([]);
  const [resolution, setResolution] = useState<AutoCodeWorkflowResolution | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydratedRef = useRef(false);
  const [concDraft, setConcDraft] = useState(
    settings.autoCodeConcurrency != null
      ? String(settings.autoCodeConcurrency)
      : '',
  );
  const [savingConc, setSavingConc] = useState(false);
  const concDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!hydratedRef.current) {
      setPathDraft(settings.linkedRepoPath ?? '');
      hydratedRef.current = true;
    }
  }, [settings.linkedRepoPath]);

  useEffect(() => {
    hydratedRef.current = false;
    setConcDraft(
      settings.autoCodeConcurrency != null
        ? String(settings.autoCodeConcurrency)
        : '',
    );
    // Re-seed the draft from the freshly-loaded folder's settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  useEffect(() => {
    let alive = true;
    void api
      .listAutoCodeWorkflows(folderId)
      .then((w) => {
        if (alive) setWorkflows(w.workflows);
      })
      .catch(() => {
        /* picker just shows Loading… until success */
      });
    return () => {
      alive = false;
    };
  }, [folderId]);

  // Workflow-resolution diagnostic — fetch fresh whenever the stored
  // selection changes (or folder switches) so the banner reflects the
  // current truth. Re-runs after `persist` flips
  // `settings.workflowTemplate` via onSettingsChange.
  useEffect(() => {
    let alive = true;
    void api
      .getAutoCodeWorkflowResolution(folderId)
      .then((r) => {
        if (alive) setResolution(r);
      })
      .catch(() => {
        if (alive) setResolution(null);
      });
    return () => {
      alive = false;
    };
  }, [folderId, settings.workflowTemplate]);

  const persist = async (
    patch: Parameters<typeof api.putConciergeFolderSettings>[1],
  ) => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.putConciergeFolderSettings(folderId, patch);
      onSettingsChange(next);
      return next;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const onChangePath = (next: string) => {
    setPathDraft(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const trimmed = next.trim();
      setSavingPath(true);
      void persist({
        linkedRepoPath: trimmed.length === 0 ? null : trimmed,
      }).finally(() => setSavingPath(false));
    }, 700);
  };

  const onToggleAutoCode = async (next: boolean) => {
    if (next && !settings.linkedRepoPath) {
      setError('Link a git repo below before enabling auto-code.');
      return;
    }
    if (next && !moEnabled) {
      setError('Enable AI Data Indexing on Access Permissions first.');
      return;
    }
    await persist({ autoCodeEnabled: next });
  };

  const onPickActive = async (workflowId: string) => {
    await persist({ workflowTemplate: workflowId });
  };

  const onChangeConcurrency = (raw: string) => {
    setConcDraft(raw);
    if (concDebounceRef.current) clearTimeout(concDebounceRef.current);
    concDebounceRef.current = setTimeout(() => {
      const trimmed = raw.trim();
      if (trimmed === '') {
        // Blank clears back to the workspace default (5).
        setSavingConc(true);
        void persist({ autoCodeConcurrency: null }).finally(() =>
          setSavingConc(false),
        );
        return;
      }
      const n = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(n) || n < 1 || n > 20) {
        setError('Max concurrent runs must be a whole number between 1 and 20.');
        return;
      }
      setError(null);
      setSavingConc(true);
      void persist({ autoCodeConcurrency: n }).finally(() =>
        setSavingConc(false),
      );
    }, 700);
  };

  // Resolve dropdown's active value with the same fallback logic the
  // legacy SettingsPane used — stored ULID wins; legacy registry id
  // falls back to the seeded default; empty stays empty.
  const stored = settings.workflowTemplate ?? '';
  const matched = workflows.find((w) => w.id === stored);
  const fallback =
    workflows.find((w) => w.isDefault) ?? workflows[0] ?? null;
  const activeId = matched?.id ?? fallback?.id ?? '';

  return (
    <section className="space-y-4">
      <SwitchRow
        label="Auto-code on this folder"
        hint="Drag a ticket to todo → Mo runs the default workflow (or the ticket's pinned workflow) on it."
        checked={settings.autoCodeEnabled}
        onChange={(v) => void onToggleAutoCode(v)}
        disabled={saving || disabled}
      />

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <label htmlFor="ac-repo" className="text-[12px] font-medium">
            Linked git repository
          </label>
          <span className="text-[10px] text-muted-foreground/70">
            {savingPath
              ? 'Saving…'
              : settings.linkedRepoPath
                ? 'Linked ✓'
                : 'Not linked'}
          </span>
        </div>
        <div className="flex items-stretch gap-2">
          <input
            id="ac-repo"
            value={pathDraft}
            onChange={(e) => onChangePath(e.target.value)}
            placeholder="/Users/me/Projects/my-app"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={disabled}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
          />
          {isTauri && (
            <button
              type="button"
              onClick={async () => {
                try {
                  const { open } = await import(
                    '@tauri-apps/plugin-dialog'
                  );
                  const picked = await open({
                    directory: true,
                    multiple: false,
                    title: 'Select repository folder',
                    defaultPath: pathDraft || undefined,
                  });
                  if (typeof picked === 'string' && picked.length > 0) {
                    // Setting the draft + persisting in one shot
                    // beats relying on the 700ms input-debounce —
                    // a folder pick is an explicit action, no need
                    // to wait.
                    onChangePath(picked);
                  }
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
              disabled={disabled}
              className="shrink-0 rounded-md border border-border bg-background px-3 text-[12px] font-medium text-foreground hover:bg-accent disabled:opacity-50"
            >
              Browse…
            </button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Absolute path to a git repo. One worktree per ticket under{' '}
          <code className="font-mono">.morion/worktrees/auto-…</code>.
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="text-[12px] font-medium">Default workflow</div>
        <p className="text-[11px] text-muted-foreground">
          The workflow that runs on every ticket dragged to{' '}
          <code>todo</code>, unless a ticket has its own workflow pinned
          via the auto-code drawer on the kanban card. Picking a custom
          workflow here also marks it as the folder's default
          (synchronised with the badge in the workflows list below).
        </p>
        <WorkflowDropdown
          workflows={workflows}
          activeId={activeId}
          disabled={saving || disabled}
          onPick={(id) => void onPickActive(id)}
        />
        {/* Resolution mismatch banner — Morion ticket
            01KRRXB2K744SKJGAZHW6KET93. Surface "what the runner is
            actually running" when the stored selection can't be
            resolved (e.g. row id pointing at a deleted workflow, or
            sidecar binary older than the row-id branch). */}
        {resolution && resolution.fellBackBecause && (
          <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-2 text-[11px] text-yellow-700 dark:text-yellow-300">
            <div className="font-medium">
              The selected workflow can't be dispatched on this version of Morion.
            </div>
            <div className="mt-0.5 text-[10px] opacity-80">
              {resolution.fellBackBecause === 'workflow_row_not_found' &&
                `Stored workflow id "${resolution.storedId.slice(0, 12)}…" doesn't match any row. The runner falls back to "${resolution.resolved.displayName}".`}
              {resolution.fellBackBecause === 'workflow_row_not_owned_by_folder' &&
                `Stored workflow id "${resolution.storedId.slice(0, 12)}…" belongs to a different folder. The runner falls back to "${resolution.resolved.displayName}".`}
              {resolution.fellBackBecause === 'unknown_template_id' &&
                `Stored template id "${resolution.storedId}" isn't recognized by this sidecar. The runner falls back to "${resolution.resolved.displayName}".`}{' '}
              Pick a built-in template from the dropdown to fix.
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <label htmlFor="ac-concurrency" className="text-[12px] font-medium">
            Max concurrent runs
          </label>
          <span className="text-[10px] text-muted-foreground/70">
            {savingConc
              ? 'Saving…'
              : settings.autoCodeConcurrency != null
                ? 'Custom'
                : 'Default (5)'}
          </span>
        </div>
        <input
          id="ac-concurrency"
          type="number"
          min={1}
          max={20}
          value={concDraft}
          onChange={(e) => onChangeConcurrency(e.target.value)}
          placeholder="5"
          disabled={disabled}
          className="w-24 rounded-md border border-border bg-background px-3 py-2 text-[12px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
        />
        <p className="text-[11px] text-muted-foreground">
          How many tickets in this folder may run agents at the same
          time. Extra tickets dragged to <code>todo</code> wait until a
          slot frees up. Leave blank for the default (5).
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </section>
  );
}
