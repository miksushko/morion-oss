import { useEffect, useRef } from 'react';
import { Circle, Loader2 } from 'lucide-react';
import type { DrawerSessionEntry } from './types';
import { useAutoCodeTranscript } from './useAutoCodeTranscript';
import { MessageBubble } from './MessageBubble';

export function TranscriptBody({
  rowId,
  session,
}: {
  rowId: string;
  session: DrawerSessionEntry;
}) {
  const { payload, status } = useAutoCodeTranscript(rowId, session);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Auto-scroll to bottom on new messages — but only if the user
  // is already near the bottom (don't yank them away from manual
  // scroll-up reading).
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    if (!scrollRef.current) return;
    if (stickToBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [payload?.messages.length]);

  const onScroll = () => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const slack = 60;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < slack;
  };

  if (!payload) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading transcript…
      </div>
    );
  }
  if (payload.messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
        <Circle className="h-5 w-5 opacity-50" />
        <div>No transcript rows yet for this session.</div>
        {payload.warnings[0] && (
          <div className="mt-2 max-w-md text-center text-xs">{payload.warnings[0]}</div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 space-y-3 overflow-y-auto px-4 py-3"
    >
      {payload.messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      {status === 'streaming' && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> live
        </div>
      )}
    </div>
  );
}
