import type { CanvasHumanGateStage } from '../types';

export function HumanGateBody({
  stage,
  onPatch,
  disabled,
}: {
  stage: CanvasHumanGateStage;
  onPatch: (p: Partial<CanvasHumanGateStage>) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-[10px] text-emerald-700 dark:text-emerald-300">
        <b>Human In The Loop.</b> Mo posts the prompt below to the
        per-ticket chat and suspends the run; the user replies with free
        text (including any decisions they want Mo to take). The reply
        is appended to the ticket context and the run resumes —
        typically by handing control back to the Mo stage that asked
        the question, which then re-evaluates with the new info and
        picks its own branch. Single-in / single-out by spec; Human
        Loop itself doesn't branch. Runtime support arrives with Phase 5
        (blocked on mo_get_context + ask_user MCP tool).
      </div>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Guidance for Mo (optional)
        <textarea
          value={stage.guidance ?? stage.prompt ?? ''}
          onChange={(e) =>
            onPatch({ guidance: e.target.value, prompt: undefined })
          }
          disabled={disabled}
          rows={4}
          placeholder='e.g. "Ask the user which design variant they want (stacked or columnar)." — Mo composes the actual chat opening at runtime by reading the ticket + comments + this hint. Leave blank to let Mo decide purely from context.'
          className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
        />
      </label>
    </div>
  );
}
