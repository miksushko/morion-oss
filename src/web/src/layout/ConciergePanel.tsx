import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  Check,
  Loader2,
  Plus,
  Search as SearchIcon,
  Send,
  Settings as SettingsIcon,
  Sparkles,
  X,
} from 'lucide-react';
import {
  api,
  type ConciergeMessage,
  type ConciergeSession,
} from '../lib/api';
import { renderCommentMarkdown } from '../lib/renderMarkdown';
import { usePrompt } from '../components/PromptDialog';
import { NOOP_NOT_CONFIGURED_MARKER } from './concierge/markers';
import {
  PENDING_TOOL_MARKER,
  parsePendingTool,
} from './concierge/pendingTool';
import { groupMessages } from './concierge/groupMessages';
import { ToolGroupChip } from './concierge/ToolGroupChip';
import { ThinkingBubble } from './concierge/ThinkingBubble';
import { NotConfiguredCTA } from './concierge/NotConfiguredCTA';
import { PendingToolApprovalCard } from './concierge/PendingToolApprovalCard';
import { QuickActionGroups } from './concierge/QuickActionGroups';
import { SidebarActionButton } from './concierge/SidebarActionButton';
import { ChatOriginTabs, type ChatOriginTab } from './concierge/ChatOriginTabs';
import { ChatList } from './concierge/ChatList';
import { ChatActionsMenu } from './concierge/ChatActionsMenu';
import { Composer } from './concierge/Composer';
import { ChatEmptyState } from './concierge/ChatEmptyState';
import { ChatSearchModal } from './concierge/ChatSearchModal';
import { useConciergeSessions } from './concierge/useConciergeSessions';
import { useConciergeConversation } from './concierge/useConciergeConversation';

/**
 * Direction V Phase V5 — full-width Concierge chat panel.
 *
 * Layout: session list left (260 px), active conversation right.
 * Sessions are ordered newest-first. Clicking one loads the transcript
 * and the composer below. Clicking "+ New chat" creates a user-opened
 * session and focuses the composer. Concierge-opened sessions carry a
 * needsHuman chip in the list so the user can find them quickly.
 *
 * Markdown rendering reuses `renderMarkdown` from Direction Q. Morion
 * image URLs inside comments are resolved via the same hook — we don't
 * re-import it here because Concierge assistants don't post morion://
 * images today (if they ever do, wrap with `useResolveMorionImages`).
 */

export interface ConciergePanelProps {
  onMobileBack: () => void;
  /** External request to open a specific chat — fires when e.g. Launch
   * Manually opened a session via `session_open` and App wants to
   * surface it. Cleared via `onPreselectConsumed` after we apply it. */
  preselectSessionId?: string | null;
  onPreselectConsumed?: () => void;
  /** When true on mount, auto-open the unified Settings popup at the
   *  Mo Agent tab (so the user lands directly on the provider-config
   *  section). Used by the "Open Mo settings" CTA in the per-folder
   *  dialog + the NotConfiguredCTA banner in chat replies. Parent
   *  clears via `onAutoOpenConsumed`. */
  autoOpenSettings?: boolean;
  onAutoOpenConsumed?: () => void;
  /** Phase 5 (epic 01KPGWTJCWVBQCCSQ8NGSB19KQ) — replaces the
   *  MoSettingsDialog modal. Click on the panel's "Mo Settings"
   *  button + the autoOpenSettings prop both route through this
   *  callback, which opens the unified Settings dialog at the
   *  `mo-agent` tab. App.tsx owns the dialog state. */
  onOpenMoAgentSettings: () => void;
  /** Called whenever internal state changes in a way that could alter
   * the sidebar needs-human badge (chat selected, message sent, chat
   * archived/deleted). Keeps the badge live without waiting for poll. */
  onSessionOpened?: () => void;
  /**
   * Sessions whose last message is still being processed by the
   * server. Lifted to App-level so the "thinking" indicator + Stop
   * button survive panel unmount (user switches to Notes tab while
   * Mo is thinking → comes back to the chat → still sees thinking
   * bubble + Stop). Map → AbortController lookup stays in App.
   */
  inflightSessionIds: Set<string>;
  /** Fire the LLM round-trip. Wraps fetch with an AbortController
   * registered in App state. Returns the same shape as the raw API
   * call. Panel manages optimistic user-bubble + transcript reload
   * around this call. */
  onSendMessage: (sessionId: string, content: string) => Promise<void>;
  /** Abort whatever request is in flight for this session. Safe to
   * call when nothing's pending — no-op. */
  onStopSending: (sessionId: string) => void;
}

export function ConciergePanel({
  onMobileBack,
  preselectSessionId,
  onPreselectConsumed,
  autoOpenSettings,
  onAutoOpenConsumed,
  onOpenMoAgentSettings,
  onSessionOpened,
  inflightSessionIds,
  onSendMessage,
  onStopSending,
}: ConciergePanelProps) {
  /** Latest messages for the currently-open chat (closure-free read for
   *  the draft-reaper in useConciergeSessions). Owned by the panel so
   *  both hooks can share it. */
  const messagesRef = useRef<ConciergeMessage[]>([]);

  const {
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
  } = useConciergeSessions({
    preselectSessionId,
    onPreselectConsumed,
    autoOpenSettings,
    onAutoOpenConsumed,
    onOpenMoAgentSettings,
    onSessionOpened,
    messagesRef,
  });

  const {
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
  } = useConciergeConversation({
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
  });

  /**
   * `originTab` — segments the chat list by who started the
   * conversation. 'all' (legacy view) / 'asked-by-me' (openedBy === 'user') /
   * 'from-mo' (openedBy === 'concierge', topic-cleanup escalations +
   * future autonomous Mo notifications). The "From Mo" tab carries an
   * unread dot when there's at least one `needsHuman` session in that
   * subset, so a user on Asked-By-Me still sees that Mo wants attention.
   *
   * Persisted to localStorage so a page reload lands the user back on
   * whichever tab they had open. Falls back to 'all' on first run / on
   * parse errors. Workspace-scoped (single key) — one Morion workspace
   * per app instance today.
   */
  const [originTab, setOriginTab] = useState<ChatOriginTab>(
    () => {
      try {
        const raw = localStorage.getItem('mo-chat.origin-tab');
        if (raw === 'all' || raw === 'asked-by-me' || raw === 'from-mo') {
          return raw;
        }
      } catch {
        /* localStorage unavailable — first-run default */
      }
      return 'all';
    },
  );
  useEffect(() => {
    try {
      localStorage.setItem('mo-chat.origin-tab', originTab);
    } catch {
      /* swallow — best-effort persistence, not load-bearing */
    }
  }, [originTab]);

  const [searchOpen, setSearchOpen] = useState(false);
  const prompt = usePrompt();

  return (
    <div className="flex h-full min-w-0 flex-1 bg-background">
      {/* Session sidebar — Mo Chat redesign 2026-05-06.
          Top: identity strip (Sparkles + Ask Mo).
          Then: All / Asked By Me / From Mo segmented tabs.
          Then: vertical action buttons (New chat / Search / Mo Settings).
          Bottom: chat list grouped by relative date.
          `bg-muted/40` tint distinguishes the chat sidebar from the
          folder sidebar (`bg-card`) AND the conversation pane
          (`bg-background`) — three different layer depths so the
          eye reads three panels, not one dark surface. */}
      <aside className="flex w-full flex-col border-r border-border bg-muted/40 md:w-64 md:shrink-0">
        {/* Identity strip — Sparkles + "Ask Mo" branding. Lightweight
            visual landmark so the panel reads as its own surface
            even before the user looks at content. Height = 52px to
            match the folder-sidebar logo block (Sidebar.tsx
            `pl-4 pr-3 py-3` + h-7 logo = 12+28+12 = 52px) so the
            top edge of Mo tabs aligns with the top edge of the
            folder-sidebar search box on the same horizontal line.
            Mobile-back integrates here on small screens. */}
        <div className="flex h-[52px] shrink-0 items-center gap-2 px-3 pt-1.5">
          <button
            type="button"
            onClick={onMobileBack}
            aria-label="Back"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold tracking-tight text-foreground">
            Ask Mo
          </span>
        </div>

        {/* Origin tabs — top of sidebar in Claude-style segmented
            pill. Full-width tabs that visually anchor the panel.
            "From Mo" carries an unread dot when there's at least one
            `needsHuman` chat in the From-Mo subset, so a user sitting
            on Asked-By-Me still sees that Mo wants attention. */}
        <ChatOriginTabs
          tab={originTab}
          onChange={setOriginTab}
          fromMoUnread={sessions.some(
            (s) => s.openedBy === 'concierge' && s.needsHuman,
          )}
        />

        {/* Vertical action buttons — full-width rows beneath tabs. */}
        <div className="relative shrink-0 px-2 pt-1 pb-2">
          <SidebarActionButton
            icon={<Plus className="h-3.5 w-3.5" />}
            label="New chat"
            onClick={() => {
              setSelectedId(null);
              setDraft('');
            }}
          />
          <SidebarActionButton
            icon={<SearchIcon className="h-3.5 w-3.5" />}
            label="Search"
            onClick={() => setSearchOpen(true)}
          />
          <SidebarActionButton
            icon={<SettingsIcon className="h-3.5 w-3.5" />}
            label="Mo Settings"
            onClick={onOpenMoAgentSettings}
          />
        </div>

        {sessions.length === 0 ? (
          <div className="p-6 text-xs text-muted-foreground">
            No chats yet. Click "New chat" to start one, or enable Mo on a folder so he can open chats himself.
          </div>
        ) : (
          <ChatList
            sessions={sessions}
            originTab={originTab}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
            onArchiveToggle={(s) => void handleArchiveToggle(s)}
            onDelete={(id) => void handleDelete(id)}
            onRename={async (s) => {
              const next = await prompt({
                title: 'Rename chat',
                label: 'Chat title',
                initial: s.title || 'Untitled chat',
                confirmLabel: 'Rename',
              });
              if (next == null) return;
              try {
                await api.patchConciergeSession(s.id, { title: next });
                setSessions((cur) =>
                  cur.map((x) => (x.id === s.id ? { ...x, title: next } : x)),
                );
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
        )}
      </aside>

      {/* Conversation */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center gap-2 px-4">
          {selectedSession && editingTitle !== null ? (
            <>
              <input
                autoFocus
                type="text"
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleRenameConfirm();
                  if (e.key === 'Escape') setEditingTitle(null);
                }}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => void handleRenameConfirm()}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-primary hover:bg-accent"
                title="Save"
                aria-label="Save title"
              >
                <Check className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setEditingTitle(null)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
                title="Cancel"
                aria-label="Cancel rename"
              >
                <X className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              <div className="min-w-0 flex-1 truncate text-sm font-semibold">
                {selectedSession?.title || (selectedSession ? 'Untitled chat' : 'Pick a chat')}
              </div>
              {selectedSession?.openedBy === 'concierge' && (
                <span className="text-[10px] uppercase tracking-wider text-primary">
                  Opened by Mo
                </span>
              )}
              {selectedSession && (
                <>
                  <ChatActionsMenu
                    chatTitle={selectedSession.title || 'Untitled chat'}
                    isArchived={selectedSession.archivedAt != null}
                    onRename={async () => {
                      const next = await prompt({
                        title: 'Rename chat',
                        label: 'Chat title',
                        initial: selectedSession.title || 'Untitled chat',
                        confirmLabel: 'Rename',
                      });
                      if (next == null) return;
                      try {
                        await api.patchConciergeSession(selectedSession.id, {
                          title: next,
                        });
                        setSessions((cur) =>
                          cur.map((x) =>
                            x.id === selectedSession.id ? { ...x, title: next } : x,
                          ),
                        );
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                    onArchive={() => void handleArchiveToggle(selectedSession)}
                    onDelete={() => void handleDelete(selectedSession.id)}
                  />
                </>
              )}
            </>
          )}
        </div>

        {error && (
          <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {selectedSession ? (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-6">
              {loadingTranscript ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : messages.length === 0 && !busy ? (
                <div className="text-sm text-muted-foreground">
                  No messages yet. Send one to get started.
                </div>
              ) : (
                <ul className="mx-auto flex max-w-3xl flex-col gap-5">
                  {groupMessages(messages).map((item) => {
                    if (item.kind === 'tool-group') {
                      return <ToolGroupChip key={item.key} group={item} />;
                    }
                    const m = item.msg;
                    if (m.role === 'user') {
                      // Right-aligned bubble, no avatar, no role label.
                      // Claude/ChatGPT pattern: self-evident by position.
                      return (
                        <li key={m.id} className="flex justify-end">
                          <div
                            className="mo-chat-prose max-w-[85%] rounded-lg bg-muted px-4 py-2.5 text-sm text-foreground"
                            dangerouslySetInnerHTML={{ __html: renderCommentMarkdown(m.content) }}
                          />
                        </li>
                      );
                    }
                    // Assistant (and anything else — tool rows are folded
                    // by groupMessages). Full-width, no bubble, no avatar.
                    // Special-case the noop "not configured" sentinel so
                    // the user gets a button straight to settings instead
                    // of a paragraph that points at settings.
                    if (m.content.startsWith(NOOP_NOT_CONFIGURED_MARKER)) {
                      return (
                        <li key={m.id} className="w-full">
                          <NotConfiguredCTA onOpenSettings={onOpenMoAgentSettings} />
                        </li>
                      );
                    }
                    if (m.content.startsWith(PENDING_TOOL_MARKER)) {
                      const payload = parsePendingTool(m.content);
                      // Resolved? Look at later messages in the array
                      // for a tool-result row referencing one of the
                      // destructive call ids. If found, render as a
                      // "completed" card without active buttons.
                      const destructiveSet = new Set(
                        payload?.destructiveCallIds ?? [],
                      );
                      const resolved = payload != null && messages.some(
                        (mm) =>
                          mm.role === 'tool' &&
                          mm.toolCallId !== null &&
                          destructiveSet.has(mm.toolCallId) &&
                          mm.createdAt >= m.createdAt,
                      );
                      return (
                        <li key={m.id} className="w-full">
                          <PendingToolApprovalCard
                            payload={payload}
                            resolved={resolved}
                            disabled={!selectedSession}
                            onDecide={(decision, reason) =>
                              void handleToolApprove(m.id, decision, reason)
                            }
                          />
                        </li>
                      );
                    }
                    return (
                      <li key={m.id} className="w-full">
                        <div
                          className="mo-chat-prose text-sm leading-relaxed text-foreground"
                          dangerouslySetInnerHTML={{ __html: renderCommentMarkdown(m.content) }}
                        />
                        {m.quickActions && m.quickActions.length > 0 && (
                          <QuickActionGroups
                            messageId={m.id}
                            actions={m.quickActions}
                            repliedActionIds={repliedActionIds}
                            onClick={(actionId) => void handleQuickAction(m.id, actionId)}
                            onCustomReply={(groupKey, text) =>
                              void handleCustomReply(groupKey, text)
                            }
                          />
                        )}
                      </li>
                    );
                  })}
                  {busy && <ThinkingBubble progressLine={progressLine} />}
                </ul>
              )}
              <div ref={scrollBottomRef} />
            </div>
            <Composer
              inputRef={composerRef}
              value={draft}
              onChange={setDraft}
              onSend={() => void handleSend()}
              onStop={handleStop}
              busy={busy}
              disabled={false}
            />
          </>
        ) : (
          <ChatEmptyState
            onStart={handleStartFromEmpty}
          />
        )}
      </section>

      {searchOpen && (
        <ChatSearchModal
          onClose={() => setSearchOpen(false)}
          onPick={(id) => {
            setSearchOpen(false);
            setSelectedId(id);
            // Refresh the session list so the picked chat is in
            // `sessions` even if it had been archive-filtered or
            // simply missed by the recent paginated load.
            void refresh();
          }}
        />
      )}
    </div>
  );
}

