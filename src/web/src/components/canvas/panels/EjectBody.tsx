import type { CanvasEjectStage } from '../types';

export function EjectBody({
  stage,
  onPatch,
  disabled,
}: {
  stage: CanvasEjectStage;
  onPatch: (p: Partial<CanvasEjectStage>) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-[10px] text-destructive">
        Terminal sink. Wire any stage's outbound edge to this node to
        eject the ticket from auto-code when that path is taken (e.g.
        reviewer's "escalate" branch). Run ends with{' '}
        <code>status='cancelled'</code> + the reason below as
        <code>lastError</code>. Runtime arrives with the DAG runner.
      </div>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Reason (surfaced on cancel comment / Ask Mo escalation)
        <textarea
          value={stage.reason}
          onChange={(e) => onPatch({ reason: e.target.value })}
          disabled={disabled}
          rows={3}
          className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
        />
      </label>
    </div>
  );
}
