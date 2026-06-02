import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { SwitchRow } from '../../SwitchRow';

export function MoPersonalitySection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getMoPersonality()
      .then((m) => alive && setEnabled(m.grumpyMode))
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
      const updated = await api.putMoPersonality({ grumpyMode: next });
      setEnabled(updated.grumpyMode);
    } catch (e) {
      setError((e as Error).message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Mo Personality</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          How Mo talks. Decisions and answer quality are unaffected —
          this is voice only.
        </p>
      </div>
      {enabled === null ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : (
        <SwitchRow
          label="Grumpy mode"
          hint="Mo speaks gruffer — long-suffering old hand voice."
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
