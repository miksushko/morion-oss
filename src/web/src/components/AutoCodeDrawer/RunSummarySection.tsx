import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  api,
  type AutoCodeDiffStatResult,
  type AutoCodeQueueRow,
} from '../../lib/api';

/**
 * Plain-English "what Mo did" section visible on Done / Done & Merged
 * states. Renders cheap git-shortstat numbers so a non-tech user sees
 * "Mo updated 2 files, +19 / −5" instead of having to dig through the
 * transcript. Fetched on demand from `/api/auto-code/runs/:id/
 * diff-stat`; cached per row id with the row id as the useEffect dep
 * so switching runs refreshes.
 */
export function RunSummarySection({ row }: { row: AutoCodeQueueRow }) {
  const [stat, setStat] = useState<AutoCodeDiffStatResult | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStat(null);
    api
      .getAutoCodeDiffStat(row.id)
      .then((s) => {
        if (cancelled) return;
        setStat(s);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setStat({ ok: false, error: 'git_error', message: (e as Error).message });
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  const headline =
    row.state === 'done_merged'
      ? 'Merged into main'
      : 'Ready to merge';
  const subline =
    row.state === 'done_merged'
      ? 'Mo finished the ticket and the branch is merged into your trunk checkout.'
      : 'Mo finished the ticket. Click "Merge into main" above to land the worktree branch on your trunk.';

  return (
    <div className="border-b bg-muted/30 px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[12px] font-medium">{headline}</div>
        <div className="text-[11px] text-muted-foreground">What Mo did</div>
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{subline}</p>
      <div className="mt-2 text-[12px]">
        {loading && (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            computing changes…
          </span>
        )}
        {!loading && stat && stat.ok && stat.files === 0 && (
          <span className="text-muted-foreground">
            No files changed. Mo may have decided everything was already in
            place, or the agent didn't finish its work — check the transcript
            below.
          </span>
        )}
        {!loading && stat && stat.ok && stat.files > 0 && (
          <div className="flex flex-wrap items-baseline gap-3">
            <span>
              Mo changed <b>{stat.files}</b>{' '}
              {stat.files === 1 ? 'file' : 'files'}.
            </span>
            <span className="font-mono text-[11px]">
              {stat.additions > 0 && (
                <span className="text-emerald-600 dark:text-emerald-400">+{stat.additions}</span>
              )}
              {stat.additions > 0 && stat.deletions > 0 && (
                <span className="text-muted-foreground"> · </span>
              )}
              {stat.deletions > 0 && (
                <span className="text-rose-600 dark:text-rose-400">−{stat.deletions}</span>
              )}
              {(stat.additions > 0 || stat.deletions > 0) && (
                <span className="text-muted-foreground"> lines</span>
              )}
            </span>
            {stat.shortStat && (
              <span
                className="font-mono text-[10px] text-muted-foreground/70"
                title={`git diff --shortstat ${stat.targetBranch}...${stat.branchName}`}
              >
                ({stat.shortStat})
              </span>
            )}
          </div>
        )}
        {!loading && stat && !stat.ok && (
          <span className="text-muted-foreground">
            Couldn't compute changes: {stat.message}
          </span>
        )}
      </div>
    </div>
  );
}
