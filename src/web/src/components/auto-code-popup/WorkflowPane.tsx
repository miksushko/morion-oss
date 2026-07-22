import { useEffect, useRef, useState } from 'react';
import { MoreVertical, Check } from 'lucide-react';

import { api } from '../../lib/api';
import type { AutoCodeWorkflowFull } from '../../lib/api';
import { ApiError } from '../../lib/api/http';
import { cn } from '../../lib/cn';
import {
  WorkflowCanvasEditor,
  type CanvasDefinition,
} from '../WorkflowCanvasEditor';

/**
 * Turn a save failure into a human message. A 422 schema-validation
 * failure carries the full `issues[]` (e.g. missing Process Start /
 * reject sink / complete sink) — render them as a checklist instead of
 * the first issue wrapped in `PUT …/workflows/<id> failed: 422:`
 * boilerplate (bug 01KVJ3G3MQRBN9K7TJ8975RN89).
 */
function formatSaveError(e: unknown): string {
  if (e instanceof ApiError && e.issues && e.issues.length > 0) {
    const lines = e.issues.map((i) => {
      const where =
        i.path && i.path !== 'definition' && i.path !== 'stages'
          ? ` (${i.path})`
          : '';
      return `• ${i.message ?? 'invalid'}${where}`;
    });
    return `Can't save this workflow — fix:\n${lines.join('\n')}`;
  }
  return (e as Error).message;
}

/**
 * Main editor pane of the AutoCode popup — name input + Save / More
 * menu (Delete with confirm) + Visual / JSON tab switch + the
 * WorkflowCanvasEditor itself. Owns load + save + delete state for
 * one workflow row at a time, with a sync-escape ref the canvas
 * editor wires up so Save reads the latest marshalled definition
 * even if React state propagation hasn't flushed.
 *
 * Extracted from AutoCodePopup.tsx 2026-05-16 (Morion ticket
 * 01KRJZ2FW12N262K6AFD7TC93K).
 */

export function WorkflowPane({
  workflowId,
  onSaved,
  onDeleted,
  onMissing,
}: {
  workflowId: string;
  onSaved: () => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
  /** Fired when the initial GET 404s — the row was deleted out
   *  from under the user's selection. Parent uses this to bounce
   *  selection back to Folder Settings so the editor doesn't sit
   *  on a red error screen. */
  onMissing?: () => void;
}) {
  const [workflow, setWorkflow] = useState<AutoCodeWorkflowFull | null>(null);
  const [definition, setDefinition] = useState<CanvasDefinition | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tab, setTab] = useState<'visual' | 'json'>('visual');
  const [jsonText, setJsonText] = useState('');
  const lastEditedRef = useRef<'visual' | 'json'>('visual');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // Ref the canvas editor wires up so onSave can read the LATEST
  // marshalled definition synchronously, bypassing any React state
  // propagation lag (2026-05-11 fix — adding stages didn't persist
  // unless the user also moved a block).
  const getLatestDefinitionRef = useRef<(() => CanvasDefinition) | null>(null);
  // Close the More dropdown when the user clicks anywhere outside
  // of it. Pointerdown on window catches both the canvas + sidebar
  // surfaces. Stop-propagation on the menu's own onClick keeps
  // inner clicks alive.
  useEffect(() => {
    if (!moreOpen) return;
    const onWindowDown = () => {
      setMoreOpen(false);
      setConfirmingDelete(false);
    };
    window.addEventListener('pointerdown', onWindowDown);
    return () => window.removeEventListener('pointerdown', onWindowDown);
  }, [moreOpen]);

  // Distinguish "row went missing" (404 — e.g. purged out by a
  // server-side sweep between the sidebar list and the click) from
  // a real network/server error. 404 renders a friendly empty
  // state in this pane; other failures show the red banner with
  // the raw message.
  const [missing, setMissing] = useState(false);
  // Keep `onMissing` in a ref so it stays callable from inside the
  // fetch effect WITHOUT being a dep of the effect. The parent
  // re-creates `onMissing` as a fresh closure on every render
  // (e.g. after `refreshWorkflows()` flips the workflows array),
  // and including it in the dep array re-fired the effect, refetched
  // the workflow, and blew away the user's in-progress edits
  // (`name`, `definition`, `dirty`, etc.) mid-session
  // (2026-05-11 user report). Effect now depends ONLY on `workflowId`
  // — the user-facing identity of the row being edited.
  const onMissingRef = useRef(onMissing);
  useEffect(() => {
    onMissingRef.current = onMissing;
  }, [onMissing]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setMissing(false);
    setDirty(false);
    void (async () => {
      try {
        const wf = await api.getAutoCodeWorkflow(workflowId);
        if (!alive) return;
        setWorkflow(wf);
        setName(wf.name);
        const def = wf.definition as CanvasDefinition;
        setDefinition(def);
        setDescription(def.description ?? '');
        setJsonText(JSON.stringify(wf.definition, null, 2));
      } catch (e) {
        if (!alive) return;
        const msg = (e as Error).message ?? '';
        if (/404|workflow_not_found/i.test(msg)) {
          setMissing(true);
          // Tell the parent so it can refresh the sidebar list —
          // the stale entry disappears, and the user picks another.
          onMissingRef.current?.();
          return;
        }
        setError(msg);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workflowId]);

  const onDefinitionChange = (next: CanvasDefinition) => {
    setDefinition(next);
    lastEditedRef.current = 'visual';
    setDirty(true);
  };

  const switchTab = (next: 'visual' | 'json') => {
    if (next === tab) return;
    if (next === 'json') {
      if (definition) setJsonText(JSON.stringify(definition, null, 2));
      setTab('json');
      return;
    }
    try {
      const parsed = JSON.parse(jsonText) as CanvasDefinition;
      setDefinition(parsed);
      setError(null);
      setTab('visual');
    } catch (e) {
      setError(`Can't switch to Visual: ${(e as Error).message}`);
    }
  };

  const onSave = async () => {
    if (!definition) return;
    setSaving(true);
    setError(null);
    // Visual edits: prefer the canvas's ref-backed latest snapshot
    // over our local `definition` state — eliminates the staleness
    // class where React batched updates haven't propagated to our
    // state by the time the user clicks Save (2026-05-11 user
    // report). Falls back to local `definition` if the ref isn't
    // wired (initial mount race) or the user is on the JSON tab.
    const liveVisual =
      lastEditedRef.current === 'visual' && getLatestDefinitionRef.current
        ? getLatestDefinitionRef.current()
        : null;
    let toSave: unknown = {
      ...(liveVisual ?? definition),
      name,
      description,
    };
    if (lastEditedRef.current === 'json') {
      try {
        toSave = JSON.parse(jsonText);
      } catch (e) {
        setError(`Definition isn't valid JSON: ${(e as Error).message}`);
        setSaving(false);
        return;
      }
    }
    try {
      await api.updateAutoCodeWorkflow(workflowId, {
        name,
        definition: toSave,
      });
      setDirty(false);
      await onSaved();
    } catch (e) {
      setError(formatSaveError(e));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    setSaving(true);
    try {
      await api.deleteAutoCodeWorkflow(workflowId);
      await onDeleted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
      setConfirmingDelete(false);
    }
  };

  // Missing state — server returned 404 (row was purged out from
  // under the selection, e.g. by a one-shot legacy sweep). Friendly
  // empty state, no red banner; the parent's onMissing handler
  // already refreshed the sidebar so the stale entry will be gone
  // on the next list call. The user just needs to pick another row
  // from the sidebar.
  if (!loading && missing) {
    return (
      <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-[11px] text-muted-foreground">
        <div className="text-foreground">This workflow no longer exists.</div>
        <p>
          The row was removed by a template update — it's been cleared
          from the sidebar. Pick another workflow from the list, or
          create a new one with <b>+ New</b>.
        </p>
      </div>
    );
  }
  // Surface a load failure (404 from a stale id, server down,
  // etc.) BEFORE the loading-spinner branch — otherwise the user
  // sits forever on "Loading workflow…" with the actual reason
  // hidden in `error` state (Codex P2b round 5, 2026-05-10).
  if (!loading && error && (!workflow || !definition)) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-[11px] text-destructive">
          Couldn't load workflow: {error}
        </div>
        <p className="text-[11px] text-muted-foreground">
          The workflow may have been deleted or moved. Pick another from
          the sidebar, or close the popup.
        </p>
      </div>
    );
  }
  if (loading || !workflow || !definition) {
    return <div className="text-xs text-muted-foreground">Loading workflow…</div>;
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-3">
      <header className="relative flex shrink-0 items-center justify-between gap-2">
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          disabled={saving}
          className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-[13px] font-medium text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={!dirty || saving}
          className="rounded-md border border-primary bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          {!dirty && !saving && <Check className="ml-1 inline h-3 w-3" />}
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMoreOpen((v) => !v);
              setConfirmingDelete(false);
            }}
            disabled={saving}
            aria-label="More actions"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {moreOpen && (
            <div
              className="absolute right-0 top-full z-20 mt-1 min-w-[180px] rounded-md border border-border bg-card p-1 shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              {!confirmingDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={saving}
                  className="block w-full rounded-sm px-2 py-1.5 text-left text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  Delete workflow
                </button>
              ) : (
                <div className="space-y-1.5 p-1">
                  <div className="text-[10px] text-destructive">
                    Sticky — won't re-seed after popup reopen.
                  </div>
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmingDelete(false);
                        setMoreOpen(false);
                      }}
                      disabled={saving}
                      className="rounded-md border border-border bg-background px-2 py-0.5 text-[10px] text-foreground hover:bg-accent disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        void onDelete();
                      }}
                      disabled={saving}
                      className="rounded-md border border-destructive bg-destructive px-2 py-0.5 text-[10px] text-destructive-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      Confirm delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </header>
      <div className="flex shrink-0 items-center gap-1 border-b border-border">
        <button
          type="button"
          onClick={() => switchTab('visual')}
          className={cn(
            'border-b-2 px-3 py-1.5 text-[11px] font-medium transition-colors',
            tab === 'visual'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          Visual
        </button>
        <button
          type="button"
          onClick={() => switchTab('json')}
          className={cn(
            'border-b-2 px-3 py-1.5 text-[11px] font-medium transition-colors',
            tab === 'json'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          JSON
        </button>
      </div>
      {error && (
        <div className="whitespace-pre-line rounded-md border border-destructive/50 bg-destructive/10 p-2 text-[11px] text-destructive">
          {error}
        </div>
      )}
      {tab === 'visual' ? (
        <WorkflowCanvasEditor
          definition={definition}
          onChange={onDefinitionChange}
          getLatestRef={getLatestDefinitionRef}
          disabled={saving}
        />
      ) : (
        <textarea
          value={jsonText}
          onChange={(e) => {
            setJsonText(e.target.value);
            lastEditedRef.current = 'json';
            setDirty(true);
          }}
          disabled={saving}
          spellCheck={false}
          className="block w-full flex-1 min-h-0 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
      )}
      {/* Delete moved to the header's More menu — keeps the
          editor's vertical real estate for the canvas instead of
          a tall footer (2026-05-11 UX feedback). The canvas
          surface owns its own one-line hint along the bottom. */}
    </div>
  );
}
