import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type PipelineModelValues,
  type PipelineModelsState,
} from '../../../lib/api';

/**
 * Per-pipeline model override fields (Phase 3.5 of epic
 * 01KPGWTJCWVBQCCSQ8NGSB19KQ). Collapsible `<details>` block under the
 * chat-tier provider settings — surfaces the seven per-backend pipeline
 * knobs that previously required a direct PUT to /api/settings:
 *
 *   - Sub-agent / decisions  (gather workers + mo_stage + composeOpening)
 *   - Synthesis (default + thorough)
 *   - Topic hygiene (primary + fallback)
 *   - Auto-code merge resolver (primary + fallback)
 *
 * Each input is debounced-autosaved (500ms). Empty value clears the
 * override and lets the resolver pick the indexing tier default.
 * Placeholders show the recommended model id as a typing aid only
 * (never a shipped default per CLAUDE.md "no hardcoded model defaults"
 * rule).
 *
 * Active backend determines which set of settings is read / written;
 * the section refreshes on backend switch via a custom event the
 * chat-tier MoProviderKeySection emits on backend save. Hidden entirely
 * (replaced by an explanatory banner) when backend != openrouter — the
 * underlying resolvers are gated to OpenRouter today.
 */
export function PipelineModelsSection() {
  const [state, setState] = useState<PipelineModelsState | null>(null);
  const [drafts, setDrafts] = useState<PipelineModelValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const lastBackendRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getConciergePipelineModels();
      setState(next);
      setDrafts(next.values);
      lastBackendRef.current = next.backend;
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Listen for the chat-tier section's backend-change broadcast so we
  // re-fetch (the per-backend setting slots are different).
  useEffect(() => {
    const onBackendChange = () => void refresh();
    window.addEventListener('mo-provider-backend-changed', onBackendChange);
    return () =>
      window.removeEventListener('mo-provider-backend-changed', onBackendChange);
  }, [refresh]);

  // Debounced autosave — fires 500ms after the last keystroke per field.
  // Same shape as MoProviderKeySection's model autosave. Skips writes
  // when the draft equals the saved value (no echo).
  useEffect(() => {
    if (!state || !drafts) return;
    const patch: Partial<PipelineModelValues> = {};
    let dirty = false;
    (Object.keys(drafts) as Array<keyof typeof drafts>).forEach((k) => {
      if (drafts[k] !== state.values[k]) {
        patch[k] = drafts[k];
        dirty = true;
      }
    });
    if (!dirty) return;
    const t = setTimeout(() => {
      void (async () => {
        setSaving(true);
        try {
          const next = await api.putConciergePipelineModels(patch);
          setState(next);
          // Don't reset drafts — user might still be typing in another
          // field; resync only the fields we just saved.
          setDrafts((cur) => (cur ? { ...cur, ...next.values } : cur));
          setError(null);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setSaving(false);
        }
      })();
    }, 500);
    return () => clearTimeout(t);
  }, [drafts, state]);

  if (state === null) {
    return (
      <div className="rounded-md border border-dashed border-border bg-background/40 p-3 text-[11px] text-muted-foreground">
        Loading pipeline overrides…
      </div>
    );
  }

  if (!state.pipelinesSupported) {
    return (
      <div className="rounded-md border border-dashed border-border bg-background/40 p-3 text-[11px] text-muted-foreground">
        <div className="mb-1 font-medium text-foreground">
          Per-pipeline overrides
        </div>
        Per-pipeline model overrides are only supported on the OpenRouter
        backend today. Switch the backend above to configure indexing /
        synthesis / topic-hygiene models per pipeline.
      </div>
    );
  }

  const setField = (key: keyof PipelineModelValues, value: string) => {
    setDrafts((cur) => (cur ? { ...cur, [key]: value } : cur));
  };

  return (
    <details className="group rounded-md border border-border bg-background/40">
      <summary className="cursor-pointer list-none px-3 py-2 text-[11px] font-medium text-foreground">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <span className="transition-transform group-open:rotate-90">▸</span>
            Per-pipeline model overrides · advanced
          </span>
          {saving && (
            <span className="text-[10px] font-normal text-muted-foreground">
              Saving…
            </span>
          )}
        </div>
      </summary>
      <div className="border-t border-border px-3 py-3">
        <p className="mb-4 text-[10px] text-muted-foreground">
          Mo runs separate cheaper / heavier models per pipeline. Leave a
          field empty to fall back to the resolver's default. Placeholder
          shows the recommended id (informational only — never a shipped
          default).
        </p>
        <div className="flex flex-col gap-5">
          {PIPELINE_FIELD_GROUPS.map((group) => (
            <div key={group.title} className="flex flex-col gap-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                {group.title}
              </div>
              {group.fields.map((f) => (
                <div key={f.key} className="flex flex-col gap-1">
                  <label
                    htmlFor={`pipeline-${f.key}`}
                    className="text-[11px] font-medium text-foreground"
                  >
                    {f.label}
                  </label>
                  <input
                    id={`pipeline-${f.key}`}
                    type="text"
                    value={drafts?.[f.key] ?? ''}
                    onChange={(e) => setField(f.key, e.target.value)}
                    placeholder={
                      state.recommended[f.key] ||
                      '(leave empty — resolver picks the default)'
                    }
                    className="w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <p className="text-[10px] text-muted-foreground">{f.hint}</p>
                </div>
              ))}
            </div>
          ))}
        </div>
        {error && (
          <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[10px] text-destructive">
            {error}
          </div>
        )}
      </div>
    </details>
  );
}

interface FieldSpec {
  key: keyof PipelineModelValues;
  label: string;
  hint: string;
}

const PIPELINE_FIELD_GROUPS: Array<{ title: string; fields: FieldSpec[] }> = [
  {
    title: 'Indexing — per-note metadata (Tier 1)',
    fields: [
      {
        key: 'tier1',
        label: 'Tier 1 · primary',
        hint: 'Runs on every note when indexing is enabled — produces summary + keywords used by Mo search. High volume; needs to be cheap. Default: Mistral Nemo.',
      },
      {
        key: 'tier1Fallback',
        label: 'Tier 1 · fallback',
        hint: 'Backup when primary fails (rate limit / malformed JSON). Default: Llama 3.1 8B.',
      },
    ],
  },
  {
    title: 'Indexing — cluster aggregation (Tier 2)',
    fields: [
      {
        key: 'tier2',
        label: 'Tier 2 · primary',
        hint: 'Cluster aggregator + Tier 2.5 catalog regen — fewer calls but heavier synthesis. Default: Qwen 235B.',
      },
      {
        key: 'tier2Fallback',
        label: 'Tier 2 · fallback',
        hint: 'Backup for cluster aggregation. Default: Mistral Small 24B.',
      },
    ],
  },
  {
    title: 'Sub-agent / workflow decisions',
    fields: [
      {
        key: 'subagent',
        label: 'Sub-agent',
        hint: 'Gather workers, mo_stage decisions in auto-code workflows, chat-tier composeOpening. Lighter / faster than chat-tier model. Empty → falls back to Tier 1.',
      },
    ],
  },
  {
    title: 'Deep-research synthesis',
    fields: [
      {
        key: 'synthesis',
        label: 'Synthesis · default',
        hint: 'mo_get_context / mo_ask synthesizer (default mode). Empty → falls back to Tier 2.',
      },
      {
        key: 'synthesisThorough',
        label: 'Synthesis · thorough',
        hint: 'Same as above for `mode: thorough` calls — heavier model worth the cost when the user asks for depth.',
      },
    ],
  },
  {
    title: 'Topic hygiene (periodic cleanup)',
    fields: [
      {
        key: 'topicHygiene',
        label: 'Topic hygiene · primary',
        hint: 'Periodic cleanup pass — proposes merges + demotes for the topic graph. Empty → falls back to Tier 2.',
      },
      {
        key: 'topicHygieneFallback',
        label: 'Topic hygiene · fallback',
        hint: 'Cheaper backup when the primary fails. Empty → mirrors Tier 2 fallback.',
      },
    ],
  },
  {
    title: 'Auto-code merge resolver',
    fields: [
      {
        key: 'mergeResolver',
        label: 'Merge resolver · primary',
        hint: 'Resolves git conflicts when auto-code merges into main. Empty → falls back to Tier 2.',
      },
      {
        key: 'mergeResolverFallback',
        label: 'Merge resolver · fallback',
        hint: 'Backup when primary returns leftover conflict markers or refuses. Empty → single-attempt mode (no retry).',
      },
    ],
  },
];
