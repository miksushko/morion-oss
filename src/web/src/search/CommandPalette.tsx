import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search as SearchIcon, FileText } from 'lucide-react';
import { api, type SearchHit, type Folder, type Note } from '../lib/api';
import { cn } from '../lib/cn';

const DEBOUNCE_MS = 150;

interface Props {
  open: boolean;
  folders: Folder[];
  onClose: () => void;
  /**
   * Receives the FULL note shape (not just the id) so the parent can navigate
   * to the note's actual folder before clamping the selection. Without
   * folderId here, App.tsx can't tell the visibleNotes-clamp effect to wait
   * for the folder-switch refresh — the clamp fires synchronously on the
   * stale `allNotes` and overrides the freshly-set selection.
   */
  onSelect: (note: Note) => void;
}

/**
 * Spotlight-style command palette. Centered modal anchored ~15vh from the
 * top of the viewport, autofocused input, debounced hit on `/api/search`,
 * keyboard nav (↑↓ Enter Esc), backdrop click to dismiss.
 *
 * Snippet rendering: FTS5 emits `<mark>...</mark>` literal HTML inside
 * `snippet`. We split on the mark tags and render the segments as text
 * nodes (never `dangerouslySetInnerHTML`) so a malicious note body can't
 * inject markup into the palette.
 */
export function CommandPalette({ open, folders, onClose, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);

  // Reset state every time the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHits([]);
    setActiveIdx(0);
    setLoading(false);
    // Focus the input on the next tick so the autofocus wins over any
    // outside focus the previous keydown might have triggered.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // Debounced search. Cancels in-flight requests by tracking the latest
  // query — late responses for stale queries are dropped.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .search(trimmed)
        .then((res) => {
          if (cancelled) return;
          setHits(res);
          setActiveIdx(0);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          console.error(err);
          setHits([]);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open]);

  // Keep the active row scrolled into view as the user navigates.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, hits]);

  if (!open) return null;

  const commit = (idx: number) => {
    const hit = hits[idx];
    if (!hit) return;
    onSelect(hit.note);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => (hits.length === 0 ? 0 : (i + 1) % hits.length));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => (hits.length === 0 ? 0 : (i - 1 + hits.length) % hits.length));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(activeIdx);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        // Backdrop click closes; clicks inside the card don't bubble here.
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Search notes"
    >
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <kbd className="hidden shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-block">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto">
          {query.trim().length === 0 ? (
            <EmptyState text="Start typing to search your notes." />
          ) : loading && hits.length === 0 ? (
            <EmptyState text="Searching..." />
          ) : hits.length === 0 ? (
            <EmptyState text="No matches." />
          ) : (
            hits.map((hit, idx) => {
              const folder = hit.note.folderId ? folderById.get(hit.note.folderId) : null;
              const active = idx === activeIdx;
              return (
                <button
                  key={hit.note.id}
                  data-idx={idx}
                  type="button"
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => commit(idx)}
                  className={cn(
                    'flex w-full items-start gap-3 border-b border-border/60 px-3 py-2.5 text-left transition-colors last:border-b-0',
                    active ? 'bg-accent' : 'hover:bg-accent/60',
                  )}
                >
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {hit.note.title || 'Untitled'}
                      </span>
                      {folder && (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {folder.name}
                        </span>
                      )}
                    </div>
                    {hit.snippet && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        <HighlightedSnippet snippet={hit.snippet} />
                      </p>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border px-1 py-px font-medium">↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border px-1 py-px font-medium">↵</kbd>
              open
            </span>
          </span>
          {hits.length > 0 && (
            <span>{hits.length} result{hits.length === 1 ? '' : 's'}</span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="px-3 py-10 text-center text-xs text-muted-foreground">{text}</div>
  );
}

/**
 * Renders an FTS5 snippet that may contain `<mark>...</mark>` markers
 * around matched terms. We never inject HTML — split into segments and
 * render the marked ones with a highlight class.
 */
function HighlightedSnippet({ snippet }: { snippet: string }) {
  const parts = useMemo(() => {
    // Split keeping the delimiters so we can toggle the marked flag.
    const out: Array<{ text: string; marked: boolean }> = [];
    const re = /<mark>([\s\S]*?)<\/mark>/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(snippet)) !== null) {
      if (m.index > last) out.push({ text: snippet.slice(last, m.index), marked: false });
      out.push({ text: m[1] ?? '', marked: true });
      last = m.index + m[0].length;
    }
    if (last < snippet.length) out.push({ text: snippet.slice(last), marked: false });
    return out;
  }, [snippet]);

  return (
    <>
      {parts.map((p, i) =>
        p.marked ? (
          <mark
            key={i}
            className="rounded-sm bg-yellow-200/70 px-0.5 text-foreground dark:bg-yellow-500/30"
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}
