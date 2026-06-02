import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { api } from '../../../lib/api';

export function MoMemorySection() {
  const [original, setOriginal] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getMoMemory()
      .then((r) => {
        if (!alive) return;
        setOriginal(r.body);
        setDraft(r.body);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 4000);
    return () => clearTimeout(t);
  }, [done]);

  const dirty = original !== null && draft !== original;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.putMoMemory(draft);
      setOriginal(r.body);
      setDraft(r.body);
      setDone(true);
    } catch (e) {
      setError((e as Error).message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Mo Memory</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          What Mo remembers about{' '}
          <strong className="text-foreground">you</strong> — preferences,
          decisions, conventions. Carried into every Mo conversation
          across every folder. Distinct from per-folder Project Memory
          (the per-folder catalog Mo maintains automatically); this one
          is workspace-wide.
        </p>
      </div>
      {original === null ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            placeholder="e.g. Address me as 'sir'. Prefer concise replies. Russian-language work products. Never auto-commit code."
            className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !dirty}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </button>
            {dirty && (
              <button
                type="button"
                onClick={() => setDraft(original)}
                className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Discard
              </button>
            )}
            {done && (
              <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                <Check className="h-3 w-3" />
                Saved
              </span>
            )}
          </div>
        </>
      )}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </section>
  );
}
