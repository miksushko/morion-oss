import { Sparkles } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Direction V — dedicated nav row for Concierge so the "needs human"
 * badge can render as a primary-tinted pill instead of the muted count
 * SidebarItem uses. Visually pops when the Concierge opened a chat the
 * user hasn't replied to yet; otherwise identical to any other nav row.
 */
export function ConciergeNavItem({
  active,
  needsHumanCount,
  thinking,
  onClick,
}: {
  active: boolean;
  needsHumanCount: number;
  thinking: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-3 py-1 text-left text-foreground transition-colors',
        active ? 'bg-accent' : 'hover:bg-accent/60',
      )}
    >
      <Sparkles
        className={cn(
          'h-3.5 w-3.5',
          thinking ? 'animate-pulse text-primary' : 'text-foreground',
        )}
      />
      <span className="flex-1 truncate">Ask Mo</span>
      {thinking && (
        // Subtle "working" dot — separate from the needs-human badge.
        // Tells the user Mo is mid-reply in some session even if they
        // navigated away from the panel. Gone the moment the reply
        // lands in DB or the user hits Stop.
        <span
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
          title="Mo is thinking…"
          aria-label="Mo is thinking"
        />
      )}
      {needsHumanCount > 0 && (
        <span
          className="inline-flex h-4 min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
          title={`${needsHumanCount} chat${needsHumanCount === 1 ? '' : 's'} awaiting your reply`}
        >
          {needsHumanCount}
        </span>
      )}
    </button>
  );
}
