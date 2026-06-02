import { useEffect, useState } from 'react';
import type { CanvasMoRouterStage } from '../types';

export function MoRouterBody({
  stage,
  onPatch,
  disabled,
}: {
  stage: CanvasMoRouterStage;
  onPatch: (p: Partial<CanvasMoRouterStage>) => void;
  disabled?: boolean;
}) {
  // Same raw-text buffer pattern as MoStageBody — without local state
  // the input strips trailing commas on every keystroke and the user
  // can't add a second branch.
  const branchesKey = (stage.branches ?? []).join('|');
  const [branchesText, setBranchesText] = useState(
    (stage.branches ?? []).join(', '),
  );
  useEffect(() => {
    setBranchesText((stage.branches ?? []).join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchesKey]);
  return (
    <div className="space-y-2">
      <div className="rounded-md border border-fuchsia-500/30 bg-fuchsia-500/10 p-2 text-[10px] text-fuchsia-700 dark:text-fuchsia-300">
        Mo reads the ticket + this instruction at runtime + picks one
        of the branches below. Wire each branch's output to the stage
        that should run when Mo picks it. Runtime support arrives with
        the DAG runner; the editor accepts the stage today so flows can
        be drafted.
      </div>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Mo's instruction
        <textarea
          value={stage.prompt}
          onChange={(e) => onPatch({ prompt: e.target.value })}
          disabled={disabled}
          rows={5}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-[11px] text-foreground"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Branches (comma-separated)
        <input
          value={branchesText}
          onChange={(e) => {
            const text = e.target.value;
            setBranchesText(text);
            onPatch({
              branches: text
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            });
          }}
          disabled={disabled}
          placeholder="bug, feature, docs"
          className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
        />
        <span className="text-[10px] text-muted-foreground">
          Each label becomes its own outbound handle on the node. Drag
          from the handle to a stage to wire that branch.
        </span>
      </label>
    </div>
  );
}
