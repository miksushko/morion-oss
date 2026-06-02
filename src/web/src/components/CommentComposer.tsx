import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, X } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';

/**
 * Plain-textarea composer for posting comments on a note.
 *
 * Not Tiptap — comments are discrete events, not live-saved documents.
 * We want Enter-to-submit, Shift+Enter-for-newline, image paste/drop,
 * and nothing else. A <textarea> gives us all three in ~100 lines
 * instead of Tiptap's multi-KB editor setup per instance.
 *
 * Image paste/drop reuses the same upload pipeline as the note-body
 * editor (Direction P): `api.uploadAttachment(file, noteId)` returns a
 * `morion://attachment/<id>` URL which we splice into the textarea at
 * the caret. The read-render side (`renderCommentMarkdown` +
 * `useResolveMorionImages`) resolves the URL to a blob on display.
 */
interface CommentComposerProps {
  noteId: string;
  /** When set, the composer renders in reply mode with a «Replying to <actor>» header and passes parentId on submit. */
  replyingTo?: { parentId: string; parentActor: string } | null;
  onCancelReply?: () => void;
  onSubmit: (body: string, parentId: string | null) => Promise<void> | void;
  /** Raised when an image upload fails. Parent decides whether to toast. */
  onUploadError?: (message: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export function CommentComposer({
  noteId,
  replyingTo,
  onCancelReply,
  onSubmit,
  onUploadError,
  placeholder = 'Add a comment…',
  autoFocus,
}: CommentComposerProps) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: expand the textarea to fit content up to ~4 lines, then
  // enable scroll. Without this a long draft clips to a single line and
  // the user can't see what they typed. Measured in scroll-height so a
  // paste of 10 lines expands to the 4-line cap without overflowing.
  const COMPOSER_MAX_LINES = 4;
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Reset to `auto` so shrink after delete works — scrollHeight on a
    // non-auto height sticks at the previous expanded value.
    el.style.height = 'auto';
    const style = window.getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 24;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const maxHeight = lineHeight * COMPOSER_MAX_LINES + paddingTop + paddingBottom;
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [body]);

  const insertAtCursor = useCallback((snippet: string) => {
    const el = textareaRef.current;
    if (!el) {
      setBody((prev) => prev + snippet);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const before = body.slice(0, start);
    const after = body.slice(end);
    const next = `${before}${snippet}${after}`;
    setBody(next);
    // Restore caret position right after the inserted snippet.
    requestAnimationFrame(() => {
      el.focus();
      const caret = (before + snippet).length;
      el.setSelectionRange(caret, caret);
    });
  }, [body]);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      for (const file of files) {
        try {
          const res = await api.uploadAttachment(file, noteId);
          const alt = file.name.replace(/\.[^.]+$/, '') || 'image';
          insertAtCursor(`\n![${alt}](${res.url})\n`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          onUploadError?.(message);
        }
      }
    },
    [noteId, insertAtCursor, onUploadError],
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = event.clipboardData.files;
      if (!items || items.length === 0) return;
      const images = Array.from(items).filter((f) => f.type.startsWith('image/'));
      if (images.length === 0) return;
      event.preventDefault();
      void uploadFiles(images);
    },
    [uploadFiles],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLTextAreaElement>) => {
      if (!event.dataTransfer.files?.length) return;
      const images = Array.from(event.dataTransfer.files).filter((f) =>
        f.type.startsWith('image/'),
      );
      if (images.length === 0) return;
      event.preventDefault();
      void uploadFiles(images);
    },
    [uploadFiles],
  );

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed, replyingTo?.parentId ?? null);
      setBody('');
      onCancelReply?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-border bg-background px-3 py-2.5">
      {replyingTo && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            Replying to <span className="font-medium text-foreground">{replyingTo.parentActor}</span>
          </span>
          <button
            type="button"
            onClick={onCancelReply}
            aria-label="Cancel reply"
            className="inline-flex h-4 w-4 items-center justify-center rounded-sm hover:bg-accent hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {/* One rounded container wraps textarea + send — border on the
          wrapper so the focus ring treats the whole field as one. Button
          is sized to match the textarea min-height (24px) so items-end
          aligns bottoms cleanly on single AND multi-line states — keeps
          the send affordance pinned to the bottom instead of floating
          mid-height as the textarea grows. */}
      <div
        className={cn(
          'flex items-end gap-1.5 rounded-lg border border-border bg-background px-3 py-2 transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring',
          busy && 'opacity-60',
        )}
      >
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          onPaste={handlePaste}
          onDrop={handleDrop}
          placeholder={placeholder}
          rows={1}
          autoFocus={autoFocus}
          // Auto-grow via effect above caps height at ~4 lines; padding +
          // leading-6 give the line-height anchor. `resize-none` disables
          // the native drag handle — we own sizing.
          className="min-h-[24px] w-full resize-none border-0 bg-transparent p-0 text-sm leading-6 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-0"
          disabled={busy}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !body.trim()}
          aria-label="Post comment"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Send className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
