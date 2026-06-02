import { cn } from '../../lib/cn';

export type ChatOriginTab = 'all' | 'asked-by-me' | 'from-mo';

/**
 * Segmented pill at the top of the Mo Chat sidebar. Tabs filter the
 * chat list by who started the conversation:
 *   - "All": everything (legacy view)
 *   - "Asked by me": openedBy === 'user'
 *   - "From Mo": openedBy === 'concierge' (topic-cleanup escalations,
 *     future autonomous Mo notifications). Carries an unread dot when
 *     fromMoUnread is true so a user sitting on Asked-By-Me still sees
 *     that Mo wants their attention.
 */
export function ChatOriginTabs({
  tab,
  onChange,
  fromMoUnread,
}: {
  tab: ChatOriginTab;
  onChange: (next: ChatOriginTab) => void;
  fromMoUnread: boolean;
}) {
  const tabs: Array<{ id: ChatOriginTab; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'asked-by-me', label: 'Asked by me' },
    { id: 'from-mo', label: 'From Mo' },
  ];
  return (
    <div
      role="tablist"
      aria-label="Filter chats by origin"
      className="flex shrink-0 gap-1 p-2"
    >
      {tabs.map((t) => {
        const active = t.id === tab;
        // "Asked by me" is the longest label and clipped on a 256px
        // sidebar at flex-1 even with px-2 padding. Give it
        // content-width (`flex-none whitespace-nowrap`) and let "All"
        // / "From Mo" share the remaining space.
        const grows = t.id !== 'asked-by-me';
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              'relative inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] font-medium transition-colors',
              grows ? 'flex-1' : 'flex-none',
              active
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
          >
            {t.label}
            {t.id === 'from-mo' && fromMoUnread && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                aria-label="Mo is awaiting your reply"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
