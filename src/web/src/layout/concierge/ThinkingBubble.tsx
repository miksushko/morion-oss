/**
 * Three-dot "Mo is thinking" indicator with optional sub-line for
 * long-running mo_get_context progress events. Sits inside the
 * conversation `<ul>` so it renders as a `<li>`.
 */
export function ThinkingBubble({ progressLine }: { progressLine?: string | null }) {
  return (
    <li className="w-full">
      <div className="inline-flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>Mo is thinking</span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60" style={{ animationDelay: '0s' }} />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60" style={{ animationDelay: '0.15s' }} />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60" style={{ animationDelay: '0.3s' }} />
        </span>
      </div>
      {progressLine && (
        // Live progress sub-line for long-running mo_get_context calls.
        // Backend pipes Wave-by-Wave events via SSE; the hook
        // (`useToolProgress`) returns the latest event the parent
        // formats here. Fixes the "Mo is thinking for 60 silent
        // seconds" UX gap from v1.4.1 dogfood (2026-05-04).
        <div className="mt-1 ml-0 max-w-[85%] text-[11px] text-muted-foreground/80 italic">
          {progressLine}
        </div>
      )}
    </li>
  );
}
