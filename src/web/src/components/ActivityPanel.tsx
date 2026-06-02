import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, MessageCircle } from 'lucide-react';
import type { ActivityRow as ActivityRowData, NoteComment } from '../lib/api';
import { api } from '../lib/api';
import { ActivityRow } from './ActivityRow';
import { CommentComposer } from './CommentComposer';
import { cn } from '../lib/cn';

/**
 * Reversed-chat activity panel (Slack / Telegram / Linear pattern).
 *
 * Layout:
 *   - Composer pinned at bottom.
 *   - Newest row at the BOTTOM of the scroll area; older history above.
 *   - Server ORDER BY ts DESC → we `toReversed()` on render so oldest is on top.
 *   - «Show more» button at the TOP loads the next older page via cursor.
 *     Scroll anchor preserved: we measure scrollHeight before and after
 *     the state update and adjust scrollTop so the user's viewport stays
 *     on the same row.
 *   - Live-sync: WAL-watcher WS broadcasts `db.changed` → we refetch the
 *     newest page. If the user is scrolled above the bottom and new rows
 *     arrive, show a `+N new` pill (Slack-style) so they can opt-in to
 *     jumping to the bottom instead of being yanked.
 *
 * Live WS events arrive via the App-level `useLiveSync` hook which
 * triggers re-renders of anything reading note data. This panel
 * subscribes to that signal via the `liveRev` prop (a counter bumped
 * on every db.changed).
 */
export interface ActivityPanelProps {
  noteId: string;
  /** Current session actor — drives Edit/Delete visibility on own posts. */
  currentActor: string;
  /** Signal bumped on every `db.changed` WS broadcast. Panel refetches
   *  newest rows when this changes. `0` on mount is fine. */
  liveRev?: number;
  /** Header title. Defaults to "Activity". Kanban card uses "Activity",
   *  EditorPane might use something else in the future. */
  title?: string;
  /** Controlled collapse state. Parent drives because the collapsed-rail
   *  rendering + width swap happens at the parent layout level. */
  collapsed: boolean;
  onToggleCollapse: () => void;
  className?: string;
  /** Raised when image upload fails during a paste/drop. Parent toasts. */
  onUploadError?: (message: string) => void;
  /** Phase 6.5 — optional ReactNode rendered in the header next to
   *  the title, used by `NoteRightPanel` to inject its tab strip
   *  (Activity / Meta Data). When present, the tab strip replaces
   *  the title slot. */
  tabSlot?: import('react').ReactNode;
}

/**
 * Page size. Matches the spec: 20 initial rows, Show more loads 20
 * more. Default HTTP limit is 20 which aligns.
 */
const PAGE_SIZE = 20;

export function ActivityPanel({
  noteId,
  currentActor,
  liveRev,
  title = 'Activity',
  collapsed,
  onToggleCollapse,
  className,
  onUploadError,
  tabSlot,
}: ActivityPanelProps) {
  const [items, setItems] = useState<ActivityRowData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSinceScroll, setNewSinceScroll] = useState(0);
  const [replyingTo, setReplyingTo] = useState<{ parentId: string; parentActor: string } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  // --- data ----------------------------------------------------------

  const refreshNewest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.listActivity(noteId, { limit: PAGE_SIZE });
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setTotal(page.total);
      setNewSinceScroll(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [noteId]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      // Before swap: record scroll anchor so the user doesn't jump.
      const scroller = scrollRef.current;
      const prevScrollHeight = scroller?.scrollHeight ?? 0;
      const prevScrollTop = scroller?.scrollTop ?? 0;

      const page = await api.listActivity(noteId, {
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
      setTotal(page.total);

      // Next frame: scrollHeight has grown, compensate scrollTop.
      requestAnimationFrame(() => {
        const s = scrollRef.current;
        if (!s) return;
        const added = s.scrollHeight - prevScrollHeight;
        s.scrollTop = prevScrollTop + added;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [noteId, nextCursor, loadingMore]);

  // Initial load + whenever note changes.
  useEffect(() => {
    if (collapsed) return; // don't hammer the server when rail-collapsed
    void refreshNewest();
  }, [collapsed, refreshNewest]);

  // Live-sync refresh: when App's WAL-watcher signals any DB change,
  // refetch the newest page. If user was scrolled above the bottom,
  // track count of new rows so we can show a `+N new` pill.
  const prevLiveRevRef = useRef(liveRev);
  useEffect(() => {
    if (liveRev == null || liveRev === prevLiveRevRef.current) return;
    prevLiveRevRef.current = liveRev;
    if (collapsed) return;
    void (async () => {
      try {
        const page = await api.listActivity(noteId, { limit: PAGE_SIZE });
        setItems((prev) => {
          // Count newly-arrived top-level entries (not counting old-cursor ones).
          const prevIds = new Set(
            prev.map((r) => (r.kind === 'comment' ? r.id : `e:${r.ts}:${r.action}`)),
          );
          const incomingIds = page.items.map((r) =>
            r.kind === 'comment' ? r.id : `e:${r.ts}:${r.action}`,
          );
          const fresh = incomingIds.filter((id) => !prevIds.has(id));
          const scroller = scrollRef.current;
          const atBottom =
            !scroller ||
            scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
          if (fresh.length > 0 && !atBottom) {
            setNewSinceScroll((n) => n + fresh.length);
          }
          return page.items;
        });
        setNextCursor(page.nextCursor);
        setTotal(page.total);
      } catch {
        // Live-refresh errors are non-fatal; keep current state.
      }
    })();
  }, [liveRev, noteId, collapsed]);

  // Keep scroll at the bottom after the INITIAL load so newest is visible.
  // Using useLayoutEffect so the scroll happens before paint, avoiding
  // a flash-of-top-of-feed.
  const initialScrolledRef = useRef(false);
  useLayoutEffect(() => {
    if (loading || collapsed || initialScrolledRef.current) return;
    const s = scrollRef.current;
    if (!s || items.length === 0) return;
    s.scrollTop = s.scrollHeight;
    initialScrolledRef.current = true;
  }, [loading, collapsed, items.length]);

  // Reset initial-scroll flag on noteId change so the NEXT note's first
  // load pins to the bottom too.
  useEffect(() => {
    initialScrolledRef.current = false;
  }, [noteId]);

  // --- mutations ------------------------------------------------------

  const handleAddComment = async (body: string, parentId: string | null) => {
    try {
      const created: NoteComment = await api.addComment(
        noteId,
        body,
        parentId ?? undefined,
      );
      // Optimistic append — append as newest so it shows at the bottom.
      setItems((prev) => [
        {
          kind: 'comment',
          id: created.id,
          noteId: created.noteId,
          parentId: created.parentId,
          body: created.body,
          actor: created.actor,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        },
        ...prev,
      ]);
      setTotal((t) => t + 1);
      // Scroll to bottom to show the new comment (we appended as newest
      // in the reverse-chronological array, which renders last).
      requestAnimationFrame(() => {
        const s = scrollRef.current;
        if (s) s.scrollTop = s.scrollHeight;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err; // let composer reset `busy` correctly
    }
  };

  const handleEditComment = async (commentId: string, newBody: string) => {
    try {
      const updated = await api.updateComment(commentId, newBody);
      setItems((prev) =>
        prev.map((r) =>
          r.kind === 'comment' && r.id === commentId
            ? { ...r, body: updated.body, updatedAt: updated.updatedAt }
            : r,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    try {
      await api.deleteComment(commentId);
      // Refresh for the cascade + the new comment_delete tombstone.
      await refreshNewest();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReply = (parentId: string) => {
    const parent = items.find((r) => r.kind === 'comment' && r.id === parentId);
    if (parent && parent.kind === 'comment') {
      setReplyingTo({ parentId, parentActor: parent.actor });
    }
  };

  const jumpToBottom = () => {
    const s = scrollRef.current;
    if (!s) return;
    s.scrollTop = s.scrollHeight;
    setNewSinceScroll(0);
  };

  // --- rendering ------------------------------------------------------

  // Build a render tree where replies appear nested under their parent,
  // but the outer list is still ordered chronologically (oldest → newest
  // because we `toReversed()` below for the reversed-chat layout).
  const { topLevel, repliesByParent } = useMemo(() => {
    const topLevel: ActivityRowData[] = [];
    const repliesByParent = new Map<string, ActivityRowData[]>();
    for (const row of items) {
      if (row.kind === 'comment' && row.parentId) {
        const arr = repliesByParent.get(row.parentId) ?? [];
        arr.push(row);
        repliesByParent.set(row.parentId, arr);
      } else {
        topLevel.push(row);
      }
    }
    // Sort replies oldest-first under each parent (chat convention —
    // newest reply at the bottom of the thread).
    for (const arr of repliesByParent.values()) {
      arr.sort((a, b) => {
        const aTs = a.kind === 'comment' ? a.createdAt : a.ts;
        const bTs = b.kind === 'comment' ? b.createdAt : b.ts;
        return aTs - bTs;
      });
    }
    return { topLevel, repliesByParent };
  }, [items]);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapse}
        className={cn(
          'flex w-10 shrink-0 flex-col items-center gap-2 border-l border-border bg-card py-3 text-muted-foreground hover:text-foreground',
          className,
        )}
        aria-label={`Expand ${title} panel`}
        title={`Expand ${title}`}
      >
        <ChevronLeft className="h-3 w-3" />
        <MessageCircle className="h-3.5 w-3.5" />
        {total > 0 && (
          <span className="text-[11px] font-medium tabular-nums">{total}</span>
        )}
      </button>
    );
  }

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-l border-border bg-card',
        className,
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        {tabSlot ?? (
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{title}</span>
            {total > 0 && (
              <span className="rounded-sm bg-accent px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                {total}
              </span>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={`Collapse ${title} panel`}
          className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </header>

      <div
        ref={scrollRef}
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {nextCursor && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="border-b border-border/60 bg-background px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
          >
            {loadingMore ? 'Loading…' : 'Show more'}
          </button>
        )}
        {loading && items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
            No activity yet. Post the first comment below.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 px-2 py-2">
            {topLevel
              .slice()
              .reverse() // server returns newest-first; reverse to oldest-first for chat flow
              .map((row) => {
                const replies =
                  row.kind === 'comment' ? repliesByParent.get(row.id) ?? [] : [];
                return (
                  <div key={rowKey(row)} className="flex flex-col gap-1">
                    <ActivityRow
                      row={row}
                      currentActor={currentActor}
                      canReply={row.kind === 'comment'}
                      onEdit={handleEditComment}
                      onDelete={handleDeleteComment}
                      onReply={handleReply}
                    />
                    {replies.map((reply) => (
                      <ActivityRow
                        key={rowKey(reply)}
                        row={reply}
                        currentActor={currentActor}
                        isReply
                        onEdit={handleEditComment}
                        onDelete={handleDeleteComment}
                      />
                    ))}
                  </div>
                );
              })}
          </div>
        )}
        {error && (
          <div className="border-t border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
            {error}
          </div>
        )}
        {newSinceScroll > 0 && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="sticky bottom-2 mx-auto mt-2 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-md hover:bg-primary/90"
          >
            {newSinceScroll} new {newSinceScroll === 1 ? 'event' : 'events'} ↓
          </button>
        )}
      </div>

      <CommentComposer
        noteId={noteId}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
        onSubmit={handleAddComment}
        onUploadError={onUploadError}
      />
    </aside>
  );
}

function rowKey(row: ActivityRowData): string {
  return row.kind === 'comment' ? row.id : `e:${row.ts}:${row.action}:${row.actor}`;
}
