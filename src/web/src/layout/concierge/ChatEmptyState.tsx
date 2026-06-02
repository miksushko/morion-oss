import { useEffect, useRef, useState } from 'react';
import { Loader2, Send } from 'lucide-react';

/**
 * Empty conversation pane — "Ready when you are." with a centred
 * composer that creates a session on first send.
 */
export function ChatEmptyState({
  onStart,
}: {
  onStart: (firstMessage: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Focus the input on mount so the user can just start typing.
  useEffect(() => {
    const t = setTimeout(() => taRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await onStart(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-24">
      <h1 className="mb-8 text-2xl font-medium tracking-tight text-foreground">
        Ready when you are.
      </h1>
      <div className="w-full max-w-2xl">
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-muted/40 p-2 focus-within:border-ring">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="Ask Mo anything…"
            rows={1}
            className="min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-6 placeholder:text-muted-foreground focus:outline-none"
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !draft.trim()}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            aria-label="Send"
            title="Send (Enter)"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
