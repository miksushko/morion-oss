import { useEffect, type KeyboardEvent, type MutableRefObject } from 'react';
import { Send } from 'lucide-react';

/**
 * Bottom composer for an active chat. Auto-grows up to ~6 lines, Enter
 * sends (Shift+Enter inserts newline). Send button swaps to a Stop
 * button while Mo is mid-reply — input stays enabled by UX contract so
 * the user can queue the next message while Mo thinks.
 */
export function Composer({
  inputRef,
  value,
  onChange,
  onSend,
  onStop,
  busy,
  disabled,
}: {
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** Mo is mid-reply. Input stays ENABLED (per UX contract — user can
   * type a next message while Mo thinks). Send button swaps to Stop. */
  busy: boolean;
  /** Feature is gated (not Pro, no selected session). Input + send
   * both disabled; Stop also disabled. */
  disabled: boolean;
}) {
  // Auto-grow up to ~6 lines. Same pattern as CommentComposer.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value, inputRef]);

  const canSend = !disabled && !busy && value.trim().length > 0;

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <div className="shrink-0 bg-background px-4 pb-3 pt-1">
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-lg border border-border bg-card px-3 py-1.5">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          disabled={disabled}
          rows={1}
          placeholder={busy ? 'Mo is thinking — or type your next message…' : 'Ask Mo or give him an instruction…'}
          className="min-h-[24px] flex-1 resize-none bg-transparent text-sm leading-6 text-foreground placeholder:text-muted-foreground/60 focus:outline-none disabled:opacity-60"
        />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            disabled={disabled}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-40"
            aria-label="Stop Mo"
            title="Stop Mo"
          >
            {/* Square stop icon — drawn inline to avoid adding another
                lucide import for a three-pixel shape. */}
            <span className="block h-2 w-2 rounded-sm bg-current" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => canSend && onSend()}
            disabled={!canSend}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
            aria-label="Send message"
            title="Send (Enter)"
          >
            <Send className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}
