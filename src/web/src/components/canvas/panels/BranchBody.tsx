import { useEffect, useState } from 'react';
import type { CanvasBranchStage } from '../types';

export function BranchBody({
  stage,
  onPatch,
  disabled,
}: {
  stage: CanvasBranchStage;
  onPatch: (p: Partial<CanvasBranchStage>) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState(JSON.stringify(stage.conditions, null, 2));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setText(JSON.stringify(stage.conditions, null, 2));
    setErr(null);
  }, [stage.conditions]);
  return (
    <div className="space-y-2">
      <div className="rounded-md border border-purple-500/30 bg-purple-500/10 p-2 text-[10px] text-purple-700 dark:text-purple-300">
        Branch stages drive DAG routing. Visual editor accepts them so
        DAG flows can be drafted; the save validator rejects them until
        the L4 DAG runner ships.
      </div>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Combinator
        <select
          value={stage.combinator ?? 'all'}
          onChange={(e) =>
            onPatch({ combinator: e.target.value as 'all' | 'any' })
          }
          disabled={disabled}
          className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
        >
          <option value="all">all (AND)</option>
          <option value="any">any (OR)</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Conditions (JSON array)
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            try {
              const parsed = JSON.parse(e.target.value);
              if (!Array.isArray(parsed)) throw new Error('expected array');
              setErr(null);
              onPatch({ conditions: parsed });
            } catch (e2) {
              setErr((e2 as Error).message);
            }
          }}
          disabled={disabled}
          rows={5}
          spellCheck={false}
          className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground"
        />
        {err && <span className="text-[10px] text-destructive">{err}</span>}
      </label>
    </div>
  );
}
