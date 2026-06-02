import { Loader2 } from 'lucide-react';
import {
  type TopicCleanupRunResult,
  type TopicCleanupStatus,
} from '../../../lib/api';

/** Topic cleanup engine card — manual trigger + last-run indicator +
 *  last-run summary. Mo merges duplicate topics + flags generic ones
 *  for tag-demote. Decisions are remembered. */
export function TopicCleanupCard({
  status,
  running,
  lastResult,
  onRun,
}: {
  status: TopicCleanupStatus | null;
  running: boolean;
  lastResult: TopicCleanupRunResult | null;
  onRun: () => void;
}) {
  const lastRunLabel = relativeLabel(status?.lastRunAt);

  return (
    <div className="rounded-md border border-border bg-background/40 px-3 py-2 text-[12px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">Topic cleanup</span>
          <span className="text-[11px] text-muted-foreground">
            Mo merges duplicate topics + flags generic ones for tag-demote. Decisions are remembered.
            {lastRunLabel ? ` Last run: ${lastRunLabel}.` : ' Never run yet.'}
          </span>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={running}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] text-foreground hover:bg-accent disabled:opacity-50"
          title="Ask Mo to scan this folder's topics for duplicates and generic categories. High-confidence merges apply automatically; ambiguous pairs open as an Ask Mo chat."
        >
          {running ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Running…
            </>
          ) : (
            'Run cleanup'
          )}
        </button>
      </div>
      {lastResult && lastResult.status === 'ok' && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          Last run: auto-merged {lastResult.autoMerged.length},
          {' '}escalated {lastResult.escalatedToChat.length} to Ask Mo
          {lastResult.escalationSessionId
            ? ' (open the Ask Mo chat to resolve)'
            : ''}
          .
        </div>
      )}
      {lastResult && lastResult.status === 'skipped' && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          Skipped: {lastResult.reason.replace(/_/g, ' ')}.
        </div>
      )}
      {lastResult && 'error' in lastResult && (
        <div className="mt-2 text-[11px] text-destructive">
          {lastResult.error}
          {lastResult.message ? `: ${lastResult.message}` : ''}
        </div>
      )}
    </div>
  );
}

/** "just now" / "12 min ago" / "3h ago" / "5d ago" for the last cleanup
 *  run timestamp. Exported for unit tests; the only caller is the
 *  TopicCleanupCard above. */
export function relativeLabel(at: number | null | undefined): string | null {
  if (!at) return null;
  const ageMs = Date.now() - at;
  const min = Math.round(ageMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}
