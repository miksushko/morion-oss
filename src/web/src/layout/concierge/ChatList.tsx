import { useMemo } from 'react';
import type { ConciergeSession } from '../../lib/api';
import { groupByDate } from '../../lib/groupByDate';
import { cn } from '../../lib/cn';
import { ChatActionsMenu } from './ChatActionsMenu';
import type { ChatOriginTab } from './ChatOriginTabs';

/**
 * Date-grouped list of chat sessions for the sidebar. Filters by
 * originTab (all / asked-by-me / from-mo) and renders each row with a
 * read-state dot + hover-revealed More menu (rename / archive / delete).
 */
export function ChatList({
  sessions,
  originTab,
  selectedId,
  onSelect,
  onArchiveToggle,
  onDelete,
  onRename,
}: {
  sessions: ConciergeSession[];
  originTab: ChatOriginTab;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onArchiveToggle: (s: ConciergeSession) => void;
  onDelete: (id: string) => void;
  onRename: (s: ConciergeSession) => void;
}) {
  const filtered = useMemo(() => {
    if (originTab === 'asked-by-me') {
      return sessions.filter((s) => s.openedBy === 'user');
    }
    if (originTab === 'from-mo') {
      return sessions.filter((s) => s.openedBy === 'concierge');
    }
    return sessions;
  }, [sessions, originTab]);

  const groups = useMemo(
    () => groupByDate(filtered, (s) => s.updatedAt),
    [filtered],
  );

  if (filtered.length === 0) {
    const emptyMsg =
      originTab === 'asked-by-me'
        ? "You haven't started any chats yet."
        : originTab === 'from-mo'
          ? "Mo hasn't opened any chats with you yet. He will when he needs your input — topic-cleanup escalations, auto-code review, etc."
          : 'No chats yet.';
    return (
      <div className="p-4 text-xs text-muted-foreground">{emptyMsg}</div>
    );
  }

  return (
    <ul className="flex-1 overflow-y-auto px-1 py-1">
      {groups.map((group) => (
        <li key={group.label}>
          <div className="px-2 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {group.label}
          </div>
          <ul>
            {group.items.map((s) => {
              const active = s.id === selectedId;
              return (
                <li key={s.id}>
                  {/* Mo Chat ticket `01KQXX6P005Y4YQZ5MPAD8ZBD0` —
                      row style mirrors the folder Sidebar (`Sidebar.tsx`
                      line 797): rounded-md pill, `bg-accent` for active,
                      `hover:bg-accent/60` for hover, NO left-border
                      stripe. Keeps the chat list visually consistent
                      with the rest of the workspace navigation. */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(s.id);
                      }
                    }}
                    className={cn(
                      'group flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      active ? 'bg-accent' : 'hover:bg-accent/60',
                    )}
                  >
                    {/* Read-state indicator. Wrapped in a `w-4` slot
                        so the dot/ring center aligns horizontally
                        with the icon center in the SidebarActionButton
                        rows above — they read as one visual column. */}
                    <span className="inline-flex w-4 shrink-0 items-center justify-center">
                      <span
                        className={cn(
                          'h-1.5 w-1.5 rounded-full',
                          s.needsHuman
                            ? 'bg-primary'
                            : 'border border-muted-foreground/40',
                        )}
                        title={s.needsHuman ? 'Awaiting your reply' : 'Read'}
                        aria-label={
                          s.needsHuman ? 'Awaiting your reply' : 'Read'
                        }
                      />
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {s.title || 'Untitled chat'}
                    </span>
                    <span
                      className="hidden shrink-0 group-hover:inline-flex"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <ChatActionsMenu
                        chatTitle={s.title || 'Untitled chat'}
                        isArchived={s.archivedAt != null}
                        onRename={() => onRename(s)}
                        onArchive={() => onArchiveToggle(s)}
                        onDelete={() => onDelete(s.id)}
                        size="sm"
                      />
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}
