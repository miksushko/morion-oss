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
import { isEmptyDraftChat } from '../../lib/discardEmptyChat';
import { useConfirm } from '../../components/ConfirmDialog';

/**
 * Session-list plumbing for the Ask Mo panel:
 *   - fetches `sessions` (and refreshes on demand)
 *   - tracks `selectedId` + derives `selectedSession`
 *   - consumes the App-level preselect / auto-open-settings handoffs
 *   - acknowledges `needsHuman` flags when the user opens a flagged chat
 *   - exposes archive / delete / rename ops
 *   - holds the freshChatIdsRef draft set + reaps abandoned drafts on
 *     selectedId change
 *
 * Conversation transcript state stays in `useConciergeConversation` —
 * the hook accepts a `messagesRef` so the draft-reaper can read the
 * current chat's message count without owning the transcript.
 */
export interface UseConciergeSessionsInput {
  preselectSessionId?: string | null;
  onPreselectConsumed?: () => void;
  autoOpenSettings?: boolean;
  onAutoOpenConsumed?: () => void;
  onOpenMoAgentSettings: () => void;
  onSessionOpened?: () => void;
  /** Live ref to the open chat's messages — owned by the conversation
   *  hook. Read closure-free at draft-reap time. */
  messagesRef: MutableRefObject<ConciergeMessage[]>;
}

export interface UseConciergeSessionsResult {
  sessions: ConciergeSession[];
  setSessions: Dispatch<SetStateAction<ConciergeSession[]>>;
  selectedId: string | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  selectedSession: ConciergeSession | null;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  editingTitle: string | null;
  setEditingTitle: Dispatch<SetStateAction<string | null>>;
  freshChatIdsRef: MutableRefObject<Set<string>>;
  refresh: () => Promise<void>;
  handleArchiveToggle: (session: ConciergeSession) => Promise<void>;
  handleDelete: (id: string) => Promise<void>;
  handleRenameConfirm: () => Promise<void>;
}

export function useConciergeSessions({
  preselectSessionId,
  onPreselectConsumed,
  autoOpenSettings,
  onAutoOpenConsumed,
  onOpenMoAgentSettings,
  onSessionOpened,
  messagesRef,
}: UseConciergeSessionsInput): UseConciergeSessionsResult {
  const [sessions, setSessions] = useState<ConciergeSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);

  const confirm = useConfirm();

  // Closure-free mirrors. acknowledgeSession + maybeDiscardEmptyChat
  // both run inside callbacks/effects whose deps array deliberately
  // excludes `sessions` (we don't want to recreate them on every list
  // refresh), so they read the latest values through these refs.
  const sessionsRef = useRef<ConciergeSession[]>([]);
  const freshChatIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listConciergeSessions({});
      setSessions(list.items);
      // No auto-select. Mo Chat ticket `01KQXVX4EBK9B9KV5E03AM8VF4`
      // (2026-05-06) — opening the panel should land on the
      // "Ready when you are" empty state, not the last conversation
      // the user happened to be on. Selection is driven by explicit
      // clicks (chat row, search hit) and the `preselectSessionId`
      // prop (Mo just opened a chat via session_open).
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // External preselect — App asks us to jump straight to a specific
  // chat (e.g. after Launch -> session_open). Consume once.
  useEffect(() => {
    if (!preselectSessionId) return;
    setSelectedId(preselectSessionId);
    onPreselectConsumed?.();
    // Refresh sessions list so the newly-opened chat is in `sessions`.
    void refresh();
  }, [preselectSessionId, onPreselectConsumed, refresh]);

  // External request to auto-open the unified Settings popup at the
  // Mo Agent tab — fired when user clicks "Open Mo settings" in the
  // per-folder no-key banner or in the NotConfiguredCTA chat reply.
  useEffect(() => {
    if (!autoOpenSettings) return;
    onOpenMoAgentSettings();
    onAutoOpenConsumed?.();
  }, [autoOpenSettings, onAutoOpenConsumed, onOpenMoAgentSettings]);

  /**
   * Clear the needsHuman flag on a chat when the user actually opens
   * it. Backend only clears on user REPLY; opening the chat is the
   * real "I've acknowledged this" signal. Fires silently — server
   * accepts the patch, local state updated so badge drops immediately.
   */
  const acknowledgeSession = useCallback(
    async (id: string) => {
      const s = sessionsRef.current.find((x) => x.id === id);
      if (!s || !s.needsHuman) return;
      try {
        await api.patchConciergeSession(id, { needsHuman: false });
        setSessions((cur) =>
          cur.map((x) => (x.id === id ? { ...x, needsHuman: false } : x)),
        );
        onSessionOpened?.();
      } catch {
        /* swallow — next tick of the sidebar poll will reconcile. */
      }
    },
    [onSessionOpened],
  );

  useEffect(() => {
    if (!selectedId) return;
    void acknowledgeSession(selectedId);
  }, [selectedId, acknowledgeSession]);

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  const handleArchiveToggle = useCallback(
    async (session: ConciergeSession) => {
      try {
        await api.patchConciergeSession(session.id, {
          archived: session.archivedAt == null,
        });
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refresh],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const session = sessionsRef.current.find((s) => s.id === id);
      const title = session?.title?.trim() || 'Untitled chat';
      const ok = await confirm({
        title: 'Delete this chat?',
        description: `"${title}" will be gone for good. The transcript can't be recovered — Mo's chats don't go to Trash.`,
        confirmLabel: 'Delete chat',
        cancelLabel: 'Keep it',
        destructive: true,
      });
      if (!ok) return;
      try {
        freshChatIdsRef.current.delete(id);
        await api.deleteConciergeSession(id);
        setSelectedId((cur) => (cur === id ? null : cur));
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [confirm, refresh],
  );

  const handleRenameConfirm = useCallback(async () => {
    if (!selectedId || editingTitle == null) return;
    const next = editingTitle.trim();
    setEditingTitle(null);
    if (!next) return;
    try {
      await api.patchConciergeSession(selectedId, { title: next });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selectedId, editingTitle, refresh]);

  /**
   * If the chat identified by `id` is a fresh draft with no messages
   * and a default title, hard-delete it and drop it from the list.
   * Called when selectedId changes (prev chat cleanup) and on unmount
   * (current chat cleanup when user navigates away from Ask Mo).
   */
  const maybeDiscardEmptyChat = useCallback(
    async (id: string) => {
      if (!freshChatIdsRef.current.has(id)) return;
      const session = sessionsRef.current.find((s) => s.id === id);
      if (!session) {
        freshChatIdsRef.current.delete(id);
        return;
      }
      const empty = isEmptyDraftChat({
        title: session.title,
        messageCount: messagesRef.current.length,
      });
      freshChatIdsRef.current.delete(id);
      if (!empty) return;
      try {
        await api.deleteConciergeSession(id);
        setSessions((cur) => cur.filter((s) => s.id !== id));
      } catch (e) {
        // 404 = already gone (race with MCP or another tab); swallow.
        const msg = (e as Error).message;
        if (!/\b404\b/.test(msg)) {
          // eslint-disable-next-line no-console
          console.warn('[concierge] discard empty chat failed', msg);
        }
      }
    },
    [messagesRef],
  );

  useEffect(() => {
    const prev = selectedId;
    return () => {
      if (prev) void maybeDiscardEmptyChat(prev);
    };
  }, [selectedId, maybeDiscardEmptyChat]);

  return {
    sessions,
    setSessions,
    selectedId,
    setSelectedId,
    selectedSession,
    error,
    setError,
    editingTitle,
    setEditingTitle,
    freshChatIdsRef,
    refresh,
    handleArchiveToggle,
    handleDelete,
    handleRenameConfirm,
  };
}
