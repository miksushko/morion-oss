import { useEffect, useRef, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { api, type TopicDocPayload } from '../../../lib/api';
import { stripPlaceholder } from '../helpers';

/** Phase 6.8 — editor for a single topic (mo:cluster:<id> note doc).
 *  Loads the doc on mount + on clusterId change, exposes a single
 *  combined textarea for the four anchored sections (overview /
 *  state / open / notes), debounced autosave (700ms). */
export function TopicEditorPane({
  folderId,
  clusterId,
  busy,
  onRegenerate,
  disabled,
}: {
  folderId: string;
  clusterId: string;
  busy: boolean;
  onRegenerate: () => void;
  disabled: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<TopicDocPayload | null>(null);
  const [overviewDraft, setOverviewDraft] = useState('');
  const [stateDraft, setStateDraft] = useState('');
  const [openDraft, setOpenDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState('');
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const overviewDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    let alive = true;
    hydrated.current = false;
    setLoading(true);
    setError(null);
    void api
      .getFolderTopicDoc(folderId, clusterId)
      .then((d) => {
        if (!alive) return;
        setDoc(d);
        setOverviewDraft(stripPlaceholder(d.sections?.overview ?? ''));
        setStateDraft(stripPlaceholder(d.sections?.state ?? ''));
        setOpenDraft(stripPlaceholder(d.sections?.open ?? ''));
        setNotesDraft(stripPlaceholder(d.sections?.notes ?? ''));
        hydrated.current = true;
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [folderId, clusterId]);

  const persistSection = async (
    section: 'overview' | 'state' | 'open' | 'notes',
    text: string,
  ) => {
    setSavingSection(section);
    setError(null);
    try {
      const updated = await api.patchFolderTopicDoc(folderId, clusterId, {
        [section]: text,
      });
      setDoc(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingSection(null);
    }
  };

  const debouncedSave = (
    section: 'overview' | 'state' | 'open' | 'notes',
    timer: { current: ReturnType<typeof setTimeout> | null },
    text: string,
  ) => {
    if (!hydrated.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void persistSection(section, text);
    }, 700);
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs italic text-muted-foreground">
        Loading {clusterId}…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="flex items-baseline justify-between">
        <h3 className="font-mono text-sm font-semibold text-foreground">
          {clusterId}
        </h3>
        <button
          type="button"
          onClick={onRegenerate}
          disabled={busy || disabled || !doc?.clusterNoteId}
          title="Force-regenerate this topic's auto sections (Tier 2 LLM call)."
          className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] text-foreground hover:bg-accent disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Play className="h-3 w-3" />
          )}
          Refresh from notes
        </button>
      </div>

      <SectionTextarea
        label="Overview"
        savingLabel={savingSection === 'overview'}
        value={overviewDraft}
        rows={4}
        onChange={(v) => {
          setOverviewDraft(v);
          debouncedSave('overview', overviewDebounce, v);
        }}
        disabled={disabled}
      />
      <SectionTextarea
        label="State"
        savingLabel={savingSection === 'state'}
        value={stateDraft}
        rows={3}
        onChange={(v) => {
          setStateDraft(v);
          debouncedSave('state', stateDebounce, v);
        }}
        disabled={disabled}
      />
      <SectionTextarea
        label="Open work"
        savingLabel={savingSection === 'open'}
        value={openDraft}
        rows={3}
        onChange={(v) => {
          setOpenDraft(v);
          debouncedSave('open', openDebounce, v);
        }}
        disabled={disabled}
      />
      <SectionTextarea
        label="Source notes"
        savingLabel={savingSection === 'notes'}
        value={notesDraft}
        rows={3}
        onChange={(v) => {
          setNotesDraft(v);
          debouncedSave('notes', notesDebounce, v);
        }}
        disabled={disabled}
      />

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

function SectionTextarea({
  label,
  value,
  rows,
  onChange,
  disabled,
  savingLabel,
}: {
  label: string;
  value: string;
  rows: number;
  onChange: (next: string) => void;
  disabled: boolean;
  savingLabel: boolean;
}) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </label>
        <span className="text-[10px] text-muted-foreground/70">
          {savingLabel ? 'Saving…' : 'auto · Mo'}
        </span>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        disabled={disabled}
        placeholder={
          disabled
            ? 'Folder hidden from AI — re-enable to edit.'
            : 'Mo writes this on the next indexing pass. Edit freely; your prose lives in the topic doc until Mo regenerates.'
        }
        className="resize-y rounded-md border border-border bg-background px-2 py-1.5 text-[12px] leading-relaxed text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
      />
    </section>
  );
}
