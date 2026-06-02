import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn';

export function CollapsedRail({
  label,
  count,
  accent,
  onExpand,
}: {
  label: string;
  count: number;
  accent: string;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className={cn(
        'flex w-10 shrink-0 flex-col items-center gap-2 rounded-lg border border-border/60 py-3 text-muted-foreground hover:text-foreground',
        accent,
      )}
      aria-label={`Expand ${label} column`}
      title={`Expand ${label} column`}
    >
      <ChevronRight className="h-3 w-3" />
      <span
        className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wider"
        style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
      >
        {label} · {count}
      </span>
    </button>
  );
}
