import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { SwitchRow } from '../../SwitchRow';

export function MoDataIndexingSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getMoPersonality()
      .then((m) => alive && setEnabled(m.checkingCornersMaster))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const toggle = async () => {
    if (enabled === null) return;
    const next = !enabled;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.putMoPersonality({
        checkingCornersMaster: next,
      });
      setEnabled(updated.checkingCornersMaster);
    } catch (e) {
      setError((e as Error).message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Mo Data Indexing</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Mo continuously indexes your notes via the configured LLM —
          summaries, keywords, cluster assignments. This is what lets Mo
          answer "what's going on in this folder" / "find me everything
          about X" with full context, instead of falling back to a plain
          keyword search. Costs tokens (and money) on the connected
          provider account.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Turn it off when you suspect Mo is burning budget on a noisy
          folder, or before a bulk-import you don't want indexed. Search
          keeps working — it just won't have summaries / cluster routing
          to lean on.
        </p>
      </div>
      {enabled === null ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : (
        <SwitchRow
          label="Index notes via LLM"
          hint="Master kill-switch. When off, no Mo indexing runs in any folder regardless of per-folder settings."
          checked={enabled}
          onChange={() => void toggle()}
          disabled={busy}
        />
      )}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </section>
  );
}
