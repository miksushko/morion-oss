import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Search as SearchIcon, X } from 'lucide-react';
import { api, type ConciergeSessionSearchHit } from '../../lib/api';
import { groupByDate } from '../../lib/groupByDate';

/**
 * Modal popup that searches across chat titles + message contents.
 * Mo Chat ticket `01KQXVCB6XQCHZ84VPN4166FH7`. Click a hit to open the
 * underlying session. Debounced 200ms so typing doesn't fire a query
 * per keystroke.
 */
export function ChatSearchModal({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (sessionId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ConciergeSessionSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus input on mount + Escape closes.
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Debounced fetch — typed-too-fast doesn't multiply requests.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setHits([]);
      setError(null);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.searchConciergeSessions(trimmed, { limit: 50 });
        setHits(r.items);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  // Group results by relative date so "Today / Past week / Past month"
  // headings appear like Claude's search popup.
  const groups = useMemo(
    () => groupByDate(hits, (s) => s.updatedAt),
    [hits],
  );

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/60 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="chat-search-title"
      onClick={onClose}
    >
      <div
        className="relative mt-16 flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        style={{ maxHeight: 'min(560px, calc(100vh - 120px))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats and messages"
            className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
            id="chat-search-title"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && (
            <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          {loading && (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              Searching…
            </div>
          )}
          {!loading && query.trim().length > 0 && hits.length === 0 && !error && (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              No matches.
            </div>
          )}
          {!loading && query.trim().length === 0 && (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              Type to search chat titles and messages.
            </div>
          )}
          {groups.map((group) => (
            <div key={group.label}>
              <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.label}
              </div>
              <ul>
                {group.items.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => onPick(s.id)}
                      className="flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left hover:bg-accent/40"
                    >
                      <span className="text-sm font-medium text-foreground">
                        {s.title || 'Untitled chat'}
                      </span>
                      {s.matchSnippet && (
                        <span className="line-clamp-1 text-xs text-muted-foreground">
                          {s.matchSnippet}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
