import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, X as XIcon } from 'lucide-react';
import { api } from '../lib/api';
import type {
  NoteMetadataPayload,
  NoteClusterAssignment,
} from '../lib/api';
import { cn } from '../lib/cn';

/**
 * Phase 6.5 — Per-note Mo metadata panel.
 *
 * Sibling of `ActivityPanel` (rendered inside the same right-rail
 * 320px slot via `NoteRightPanel`). Surfaces the read-only Mo-owned
 * fields (summary, keywords, computed_by, confidence, computed_at)
 * and the user-controlled `mo_hands_off` flag + cluster set.
 *
 * Hard contracts:
 *   - User-edited cluster set goes through PUT /api/notes/:id/clusters
 *     which writes with source='user' and enqueues affected clusters
 *     for Tier 2 regen.
 *   - The summary/keywords textarea is intentionally read-only — those
 *     fields are auto-maintained by the indexing pipeline and any
 *     user prose belongs in the note body itself, between
 *     `<!-- mo:section-* -->` anchors (Phase 6.6).
 *   - When metadata is null (Tier 1 hasn't run yet), a placeholder
 *     surfaces the transient state plainly.
 */

export interface MetaDataPanelProps {
  noteId: string;
  /** Bumped on `db.changed` WS — refetches metadata when active. */
  liveRev?: number;
}

export function MetaDataPanel({
  noteId,
  liveRev,
}: MetaDataPanelProps) {
  const [data, setData] = useState<NoteMetadataPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingHandsOff, setSavingHandsOff] = useState(false);
  const [savingClusters, setSavingClusters] = useState(false);
  const [savingSummary, setSavingSummary] = useState(false);
  const [savingKeywords, setSavingKeywords] = useState(false);
  const [newClusterDraft, setNewClusterDraft] = useState('');
  const [summaryDraft, setSummaryDraft] = useState('');
  const [keywordsDraft, setKeywordsDraft] = useState('');
  const summaryDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keywordsDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const summaryHydrated = useRef(false);
  const keywordsHydrated = useRef(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api.getNoteMetadata(noteId);
      setData(payload);
      // Hydrate edit drafts ONCE per note. Re-hydrating on every
      // refetch would clobber in-flight user edits with the stored
      // value (same ref-gate pattern as FolderSettingsDialog
      // workflow textarea).
      if (!summaryHydrated.current) {
        setSummaryDraft(payload.metadata?.summary ?? '');
        summaryHydrated.current = true;
      }
      if (!keywordsHydrated.current) {
        setKeywordsDraft((payload.metadata?.keywords ?? []).join(', '));
        keywordsHydrated.current = true;
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Note switch — reset hydration so the new note's stored
    // metadata replaces the drafts cleanly.
    summaryHydrated.current = false;
    keywordsHydrated.current = false;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, liveRev]);

  const onToggleHandsOff = async () => {
    if (!data) return;
    const next = !(data.metadata?.moHandsOff ?? false);
    setSavingHandsOff(true);
    setError(null);
    try {
      const updated = await api.patchNoteMetadata(noteId, { moHandsOff: next });
      setData(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingHandsOff(false);
    }
  };

  const replaceClusters = async (next: string[]) => {
    setSavingClusters(true);
    setError(null);
    try {
      const result = await api.putNoteClusters(noteId, next);
      // Reload full payload so the metadata view picks up any side effects.
      setData((prev) =>
        prev
          ? { noteId, metadata: prev.metadata, clusters: result.clusters }
          : prev,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingClusters(false);
    }
  };

  const removeCluster = async (clusterId: string) => {
    if (!data) return;
    const next = data.clusters
      .map((c) => c.clusterId)
      .filter((id) => id !== clusterId);
    await replaceClusters(next);
  };

  const addCluster = async () => {
    const trimmed = newClusterDraft.trim();
    if (!trimmed || !data) return;
    if (data.clusters.some((c) => c.clusterId === trimmed)) {
      setNewClusterDraft('');
      return;
    }
    const next = [...data.clusters.map((c) => c.clusterId), trimmed];
    setNewClusterDraft('');
    await replaceClusters(next);
  };

  const persistSummary = async (next: string) => {
    setSavingSummary(true);
    setError(null);
    try {
      const updated = await api.patchNoteMetadata(noteId, { summary: next });
      setData(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingSummary(false);
    }
  };

  const persistKeywords = async (next: string[]) => {
    setSavingKeywords(true);
    setError(null);
    try {
      const updated = await api.patchNoteMetadata(noteId, { keywords: next });
      setData(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingKeywords(false);
    }
  };

  const onChangeSummary = (next: string) => {
    setSummaryDraft(next);
    if (summaryDebounce.current) clearTimeout(summaryDebounce.current);
    summaryDebounce.current = setTimeout(() => {
      void persistSummary(next);
    }, 600);
  };

  const onChangeKeywords = (next: string) => {
    setKeywordsDraft(next);
    if (keywordsDebounce.current) clearTimeout(keywordsDebounce.current);
    keywordsDebounce.current = setTimeout(() => {
      const parsed = next
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      void persistKeywords(parsed);
    }, 600);
  };

  if (loading && !data) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading metadata…
      </div>
    );
  }

  const meta = data?.metadata;
  const clusters = data?.clusters ?? [];
  const handsOff = meta?.moHandsOff ?? false;

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3 text-sm">
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Summary
          </h3>
          <span className="text-[10px] text-muted-foreground/70">
            {meta?.computedBy === 'user'
              ? 'edited by you'
              : meta?.computedBy
                ? `auto · ${meta.computedBy}`
                : 'auto · Mo'}
          </span>
        </div>
        <textarea
          value={summaryDraft}
          onChange={(e) => onChangeSummary(e.target.value)}
          placeholder="Mo writes a 1-3 sentence summary on the next indexing pass. Edit freely — your text replaces Mo's and survives future regens."
          rows={3}
          className="resize-y rounded-md border border-border bg-background px-2 py-1.5 text-[12px] leading-relaxed text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
        <div className="text-[10px] text-muted-foreground">
          {savingSummary ? 'Saving…' : 'Autosaves while you type.'}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Keywords
          </h3>
          <span className="text-[10px] text-muted-foreground/70">
            {meta?.computedBy === 'user'
              ? 'edited by you'
              : meta?.computedBy
                ? `auto · ${meta.computedBy}`
                : 'auto · Mo'}
          </span>
        </div>
        <input
          value={keywordsDraft}
          onChange={(e) => onChangeKeywords(e.target.value)}
          placeholder="Comma-separated. Replaces Mo's auto list."
          className="h-7 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
        <div className="text-[10px] text-muted-foreground">
          {savingKeywords ? 'Saving…' : 'Autosaves on pause.'}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Clusters
          </h3>
          <span className="text-[10px] text-muted-foreground">
            {clusters.length} assigned
          </span>
        </div>
        <ul className="flex flex-col gap-1">
          {clusters.length === 0 && (
            <li className="text-[12px] italic text-muted-foreground">
              Mo hasn't assigned any clusters yet.
            </li>
          )}
          {clusters.map((c) => (
            <li
              key={c.clusterId}
              className="flex items-center gap-2 rounded-md border border-border/60 bg-card px-2 py-1"
            >
              <span className="font-mono text-[12px] text-foreground">
                {c.clusterId}
              </span>
              <span
                className={cn(
                  'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide',
                  c.source === 'user'
                    ? 'bg-primary/15 text-primary'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {c.source}
              </span>
              <button
                type="button"
                onClick={() => void removeCluster(c.clusterId)}
                disabled={savingClusters}
                title="Remove this cluster from the note (writes a user override)."
                className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-1">
          <input
            value={newClusterDraft}
            onChange={(e) => setNewClusterDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void addCluster();
              }
            }}
            placeholder="Add cluster id (e.g. kanban-ui)"
            disabled={savingClusters}
            className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void addCluster()}
            disabled={savingClusters || !newClusterDraft.trim()}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] text-foreground hover:bg-accent disabled:opacity-50"
          >
            {savingClusters ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            Add
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Mo control
        </h3>
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 bg-card px-3 py-2">
          <input
            type="checkbox"
            checked={handsOff}
            onChange={() => void onToggleHandsOff()}
            disabled={savingHandsOff}
            className="mt-0.5 h-4 w-4"
          />
          <span className="flex-1 text-[12px] leading-relaxed text-foreground">
            <span className="font-medium">Mo hands-off</span>
            <span className="block text-[11px] text-muted-foreground">
              When checked, Mo's indexing pipeline skips this note entirely — no summary, no clusters, no patrol findings. The note still appears in keyword search.
            </span>
          </span>
        </label>
      </section>

      {meta && (
        <section className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          <div>
            Computed by:{' '}
            <span className="font-mono text-foreground">
              {meta.computedBy ?? 'never'}
            </span>
          </div>
          {meta.computedAt != null && (
            <div>
              Last computed:{' '}
              {new Date(meta.computedAt).toLocaleString(undefined, {
                dateStyle: 'short',
                timeStyle: 'short',
              })}
            </div>
          )}
          {meta.confidence != null && (
            <div>Confidence: {(meta.confidence * 100).toFixed(0)}%</div>
          )}
        </section>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}
