import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import {
  api,
  type ConciergeMessage,
  type ConciergeSession,
} from '../../lib/api';
import { useToolProgress, formatProgressLine } from '../../hooks/useToolProgress';
import { deriveSessionTitle } from './deriveSessionTitle';

/**
 * Conversation-pane plumbing for the Ask Mo panel:
 *   - owns transcript state (`messages` + `loadingTranscript`)
 *   - drives transcript reload on `selectedId` change
 *   - syncs the external `messagesRef` for the sessions hook's
 *     draft-reaper
 *   - owns `draft` + the composer ref + scroll/focus side-effects
 *   - exposes `handleNewChat` / `handleSend` / `handleStop` /
 *     `handleQuickAction` / `handleCustomReply` / `handleToolApprove`
 *   - derives `busy` from the App-lifted inflight set and pipes
 *     `progressLine` through `useToolProgress`
 *   - memoises `repliedActionIds` from the transcript so quick-action
 *     siblings collapse the moment a button is clicked
 *
 * Session-list state stays in `useConciergeSessions` — this hook
 * receives `selectedId`/`refresh`/`sessions`/`freshChatIdsRef`/`setError`
 * from there.
 */
export interface UseConciergeConversationInput {
  onSessionOpened?: () => void;
  inflightSessionIds: Set<string>;
  onSendMessage: (sessionId: string, content: string) => Promise<void>;
  onStopSending: (sessionId: string) => void;
  /** Wired from useConciergeSessions. */
  selectedId: string | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  selectedSession: ConciergeSession | null;
  sessions: ConciergeSession[];
  refresh: () => Promise<void>;
  freshChatIdsRef: MutableRefObject<Set<string>>;
  setError: Dispatch<SetStateAction<string | null>>;
  /** Owned by the panel; kept in sync here so the sessions-hook
   *  draft-reaper can read the current chat's message count. */
  messagesRef: MutableRefObject<ConciergeMessage[]>;
}

export interface UseConciergeConversationResult {
  messages: ConciergeMessage[];
  loadingTranscript: boolean;
  busy: boolean;
  progressLine: string | null;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  composerRef: MutableRefObject<HTMLTextAreaElement | null>;
  scrollBottomRef: MutableRefObject<HTMLDivElement | null>;
  repliedActionIds: Set<string>;
  handleSend: () => Promise<void>;
  handleStop: () => void;
  handleQuickAction: (messageId: string, actionId: string) => Promise<void>;
  handleCustomReply: (groupKey: string, text: string) => Promise<void>;
  handleToolApprove: (
    messageId: string,
    decision: 'approve' | 'deny',
    reason?: string,
  ) => Promise<void>;
  /** Start a new chat from the empty-state composer: creates a session
   *  with an auto-derived title, selects it, and posts the first user
   *  message through the regular send pipeline so App-level inflight
   *  tracking + Stop button + transcript reload all work. */
  handleStartFromEmpty: (firstMessage: string) => Promise<void>;
}

export function useConciergeConversation({
  onSessionOpened,
  inflightSessionIds,
  onSendMessage,
  onStopSending,
  selectedId,
  setSelectedId,
  selectedSession,
  sessions,
  refresh,
  freshChatIdsRef,
  setError,
  messagesRef,
}: UseConciergeConversationInput): UseConciergeConversationResult {
  const [messages, setMessages] = useState<ConciergeMessage[]>([]);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [draft, setDraft] = useState('');

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollBottomRef = useRef<HTMLDivElement | null>(null);

  // Session-level busy — derived from App-lifted inflight set so the
  // thinking bubble + Stop button survive panel unmount/remount.
  const busy = selectedId ? inflightSessionIds.has(selectedId) : false;
  // Live progress events from long-running mo_get_context dispatches.
  // The hook gates itself on `busy`; when the user-message POST
  // resolves and busy flips false, the EventSource closes and events
  // clear. Renders as a sub-line under ThinkingBubble.
  const progressEvents = useToolProgress(selectedId, busy);
  const latestProgress = progressEvents[progressEvents.length - 1] ?? null;
  const progressLine = latestProgress ? formatProgressLine(latestProgress) : null;

  // Mirror the transcript out to the panel-owned ref so the sessions
  // hook's draft-reaper can read message count closure-free.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages, messagesRef]);

  // Transcript loader — fires when the user picks a chat. Filters
  // role='system' rows; they're infrastructure, not conversation.
  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    setLoadingTranscript(true);
    api
      .listConciergeMessages(selectedId)
      .then(({ items }) => {
        setMessages(items.filter((m) => m.role !== 'system'));
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoadingTranscript(false));
  }, [selectedId, setError]);

  // Auto-focus composer whenever the user opens a chat (new or existing).
  // setTimeout lets the Composer mount + the browser settle focus away
  // from the +New-chat button (which steals focus on click). rAF alone
  // loses this race on some reconciliation paths.
  useEffect(() => {
    if (!selectedSession) return;
    const t = setTimeout(() => composerRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, [selectedSession?.id]);

  // Keep scroll pinned to the bottom as new messages arrive.
  useEffect(() => {
    scrollBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, busy]);

  const reloadTranscriptOrDropPending = useCallback(
    async (sid: string, pendingId: string | null) => {
      try {
        const refreshed = await api.listConciergeMessages(sid);
        setMessages(refreshed.items.filter((m) => m.role !== 'system'));
      } catch {
        if (pendingId != null) {
          setMessages((m) => m.filter((x) => x.id !== pendingId));
        }
      }
    },
    [],
  );

  const handleSend = useCallback(async () => {
    if (!selectedId || !draft.trim()) return;
    // First send promotes the draft to a real chat — remove from the
    // discard-on-navigate set so we don't reap it out from under the
    // reply we're about to receive.
    freshChatIdsRef.current.delete(selectedId);
    const content = draft.trim();
    setDraft('');
    // If this session doesn't have a meaningful title yet, derive one
    // from the first user message.
    const currentSession = sessions.find((s) => s.id === selectedId);
    const shouldAutoTitle =
      currentSession &&
      (currentSession.title.trim() === '' || currentSession.title === 'New chat');
    // Optimistic: append user turn immediately so the bubble feels
    // snappy. The full transcript reload after the send settles will
    // replace this with the server-persisted rows.
    const pendingUser: ConciergeMessage = {
      id: `pending_${Date.now()}`,
      sessionId: selectedId,
      role: 'user',
      content,
      toolCallId: null,
      costUsd: 0,
      tokensIn: null,
      tokensOut: null,
      model: null,
      createdAt: Date.now(),
      quickActions: null,
      repliedActionId: null,
    };
    setMessages((m) => [...m, pendingUser]);
    try {
      await Promise.all([
        onSendMessage(selectedId, content),
        shouldAutoTitle
          ? api
              .patchConciergeSession(selectedId, {
                title: deriveSessionTitle(content),
              })
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      // Pull the full transcript back — the HTTP response only carries
      // the user turn + final assistant turn, but a tool-calling loop
      // writes intermediate rows (assistant-with-querying-marker +
      // role='tool' payloads) that the grouper needs to show tool
      // chips. Rebuilding state from the DB keeps UI == transcript.
      await reloadTranscriptOrDropPending(selectedId, pendingUser.id);
      // Re-fetch sessions list so updated_at ordering + auto-titled row
      // reflect the turn.
      void refresh();
    } catch (e) {
      // Aborted sends are not errors — they're a user action. Refresh
      // the transcript anyway so the pending optimistic user bubble
      // gets replaced by the server-persisted row (the user message
      // was written BEFORE the provider call, so it survives an abort
      // mid-provider).
      const msg = (e as Error).message;
      if (!/abort/i.test(msg)) {
        setError(msg);
      }
      await reloadTranscriptOrDropPending(selectedId, pendingUser.id);
    } finally {
      composerRef.current?.focus();
    }
  }, [
    selectedId,
    draft,
    sessions,
    onSendMessage,
    refresh,
    setError,
    freshChatIdsRef,
    reloadTranscriptOrDropPending,
  ]);

  const handleStop = useCallback(() => {
    if (!selectedId) return;
    onStopSending(selectedId);
  }, [selectedId, onStopSending]);

  // Set of every action id that already produced a user reply in this
  // session — drives the disabled state of sibling quick-action
  // buttons. Recomputed when `messages` changes (covers both the
  // happy click path and external session imports).
  const repliedActionIds = useMemo(() => {
    const s = new Set<string>();
    for (const m of messages) {
      if (m.repliedActionId) s.add(m.repliedActionId);
    }
    return s;
  }, [messages]);

  const handleQuickAction = useCallback(
    async (messageId: string, actionId: string) => {
      if (!selectedId) return;
      try {
        await api.applyConciergeQuickAction(selectedId, messageId, actionId);
        const refreshed = await api.listConciergeMessages(selectedId);
        setMessages(refreshed.items.filter((m) => m.role !== 'system'));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [selectedId, setError],
  );

  /**
   * Custom-instruction reply for a quick-action group ("Give different
   * instruction"). Goes through the standard chat send path so Mo can
   * react in-thread, but tags the user message with a phantom
   * `<group-key>:custom` repliedActionId so the UI collapses the group
   * on the next render — same as if the user had picked a structured
   * option.
   */
  const handleCustomReply = useCallback(
    async (groupKey: string, text: string) => {
      if (!selectedId) return;
      try {
        await api.sendConciergeMessage(selectedId, text, {
          repliedActionId: `${groupKey}:custom`,
        });
        const refreshed = await api.listConciergeMessages(selectedId);
        setMessages(refreshed.items.filter((m) => m.role !== 'system'));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [selectedId, setError],
  );

  /**
   * Codex finding 01KQ1H5MKPBG7DY0730VRRW178. Approve / Deny a
   * destructive tool call Mo asked for. Server dispatches (or
   * synthesises a deny envelope), persists tool result rows, and
   * re-enters the chat loop so Mo can react.
   */
  const handleToolApprove = useCallback(
    async (
      messageId: string,
      decision: 'approve' | 'deny',
      reason?: string,
    ) => {
      if (!selectedId) return;
      try {
        await api.approveConciergeTool(selectedId, messageId, decision, reason);
        const refreshed = await api.listConciergeMessages(selectedId);
        setMessages(refreshed.items.filter((m) => m.role !== 'system'));
        // Bump sidebar needs-human badge — Mo may have closed an
        // open-needs-reply chat with this turn.
        api
          .listConciergeSessions({ limit: 1 })
          .then(() => onSessionOpened?.())
          .catch(() => {});
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [selectedId, onSessionOpened, setError],
  );

  const handleStartFromEmpty = useCallback(
    async (firstMessage: string) => {
      try {
        const session = await api.createConciergeSession({
          title: deriveSessionTitle(firstMessage),
        });
        await refresh();
        setSelectedId(session.id);
        // Hand the message off to the regular send pipeline so App-level
        // inflightSessionIds tracking + abort still work. The auto-title
        // is already set above, so handleSend's auto-title branch becomes
        // a no-op on the next user reply — clean.
        setDraft('');
        await onSendMessage(session.id, firstMessage);
        // Reload transcript so the assistant turn renders.
        try {
          const refreshed = await api.listConciergeMessages(session.id);
          setMessages(refreshed.items.filter((m) => m.role !== 'system'));
        } catch {
          /* swallow — next refresh tick reconciles */
        }
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refresh, setSelectedId, onSendMessage, setError],
  );

  return {
    messages,
    loadingTranscript,
    busy,
    progressLine,
    draft,
    setDraft,
    composerRef,
    scrollBottomRef,
    repliedActionIds,
    handleSend,
    handleStop,
    handleQuickAction,
    handleCustomReply,
    handleToolApprove,
    handleStartFromEmpty,
  };
}
