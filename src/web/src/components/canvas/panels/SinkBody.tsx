import type {
  CanvasRejectSinkStage,
  CanvasCompleteSinkStage,
} from '../types';

/** Side-panel body for reject + complete terminal sinks. Same shape
 *  (commentTemplate + pinned banner) — variant toggles the copy and
 *  the colour. */
export function SinkBody<
  S extends CanvasRejectSinkStage | CanvasCompleteSinkStage,
>({
  stage,
  onPatch,
  disabled,
  variant,
}: {
  stage: S;
  onPatch: (p: Partial<S>) => void;
  disabled?: boolean;
  variant: 'reject' | 'complete';
}) {
  const variantCopy =
    variant === 'reject'
      ? {
          banner:
            'Terminal reject sink. Reaching this node ends the run with the ticket moved to backlog + a Mo comment explaining why.',
          placeholder:
            'e.g. "Auto-code rejected — {{reason}}. Reopen manually after triage."',
          tone: 'destructive',
        }
      : {
          banner:
            'Terminal complete sink. Reaching this node ends the run with the ticket moved to done + a closing Mo comment.',
          placeholder: 'e.g. "Auto-code complete — {{summary}}."',
          tone: 'emerald',
        };
  const boxClass =
    variantCopy.tone === 'destructive'
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  return (
    <div className="space-y-2">
      <div className={'rounded-md border p-2 text-[10px] ' + boxClass}>
        {variantCopy.banner} Pinned — can't be deleted from the canvas
        (every v2 workflow needs exactly one Reject + one Complete sink).
        Runtime arrives with Phase 4 DAG runner.
      </div>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Comment template (optional; leave empty for Mo's default)
        <textarea
          value={stage.commentTemplate ?? ''}
          onChange={(e) =>
            onPatch({ commentTemplate: e.target.value } as Partial<S>)
          }
          disabled={disabled}
          rows={3}
          placeholder={variantCopy.placeholder}
          className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
        />
      </label>
    </div>
  );
}
