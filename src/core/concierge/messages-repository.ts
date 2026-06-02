import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import type {
  ConciergeMessage,
  ConciergeMessageRole,
  ConciergeQuickAction,
} from './types.js';

const ulid = monotonicFactory();

interface Row {
  id: string;
  session_id: string;
  role: ConciergeMessageRole;
  content: string;
  tool_call_id: string | null;
  cost_usd: number;
  tokens_in: number | null;
  tokens_out: number | null;
  model: string | null;
  created_at: number;
  quick_actions: string | null;
  replied_action_id: string | null;
}

function rowToMessage(row: Row): ConciergeMessage {
  let quickActions: ConciergeQuickAction[] | null = null;
  if (row.quick_actions) {
    try {
      const parsed = JSON.parse(row.quick_actions);
      if (Array.isArray(parsed)) quickActions = parsed as ConciergeQuickAction[];
    } catch {
      // Corrupt JSON shouldn't blow up the message read — surface as
      // null so the UI just renders the message without buttons.
      quickActions = null;
    }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    toolCallId: row.tool_call_id,
    costUsd: row.cost_usd,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    model: row.model,
    createdAt: row.created_at,
    quickActions,
    repliedActionId: row.replied_action_id,
  };
}

export interface CreateMessageInput {
  sessionId: string;
  role: ConciergeMessageRole;
  content: string;
  toolCallId?: string | null;
  costUsd?: number;
  tokensIn?: number | null;
  tokensOut?: number | null;
  model?: string | null;
  /** Quick-action buttons to render under the assistant bubble. Set
   *  ONLY on assistant messages that need a discrete user choice
   *  (e.g. topic-cleanup edge cases). Producer / consumer share the
   *  payload schema by convention via `payload.kind`. */
  quickActions?: ConciergeQuickAction[];
  /** When this user message was created by clicking a quick-action,
   *  this is the action id from the parent assistant message's
   *  `quickActions[].id`. Used by the UI to collapse used buttons. */
  repliedActionId?: string | null;
}

/**
 * Direction V — Concierge chat messages.
 *
 * Tightly coupled to `ConciergeSessionsRepository.touch` — every insert
 * bumps the parent session's `updated_at` so the sidebar list sorts
 * newest-chat-first. The sibling call is explicit rather than trigger-
 * driven so tests and engine code can see the causality.
 */
export class ConciergeMessagesRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateMessageInput, now: number = Date.now()): ConciergeMessage {
    const id = ulid(now);
    const quickActionsJson = input.quickActions
      ? JSON.stringify(input.quickActions)
      : null;
    const row: Row = {
      id,
      session_id: input.sessionId,
      role: input.role,
      content: input.content,
      tool_call_id: input.toolCallId ?? null,
      cost_usd: input.costUsd ?? 0,
      tokens_in: input.tokensIn ?? null,
      tokens_out: input.tokensOut ?? null,
      model: input.model ?? null,
      created_at: now,
      quick_actions: quickActionsJson,
      replied_action_id: input.repliedActionId ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO concierge_messages (
           id, session_id, role, content, tool_call_id,
           cost_usd, tokens_in, tokens_out, model, created_at,
           quick_actions, replied_action_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.session_id,
        row.role,
        row.content,
        row.tool_call_id,
        row.cost_usd,
        row.tokens_in,
        row.tokens_out,
        row.model,
        row.created_at,
        row.quick_actions,
        row.replied_action_id,
      );
    return rowToMessage(row);
  }

  /** Lookup by id within a session — used by the quick-action consumer
   *  route to fetch the assistant message whose action was clicked,
   *  resolve the action payload, and verify session ownership. */
  getById(id: string): ConciergeMessage | null {
    const row = this.db
      .prepare<[string], Row>('SELECT * FROM concierge_messages WHERE id = ?')
      .get(id);
    return row ? rowToMessage(row) : null;
  }

  /** All `replied_action_id` values for a session — UI uses this to
   *  collapse buttons whose action has already been clicked (the
   *  user's reply created a sibling user message with that id). */
  listRepliedActionIds(sessionId: string): string[] {
    const rows = this.db
      .prepare<[string], { replied_action_id: string }>(
        `SELECT DISTINCT replied_action_id
           FROM concierge_messages
          WHERE session_id = ? AND replied_action_id IS NOT NULL`,
      )
      .all(sessionId);
    return rows.map((r) => r.replied_action_id);
  }

  /** Oldest-first transcript for a session. LLM provider calls receive
   * the list as-is (optionally trimmed by token budget at the caller).
   *
   * NB: this method takes the FIRST `limit` rows oldest-first. For
   * sessions whose row count exceeds `limit`, the most recent rows
   * (including a freshly-inserted user message in the chat path) get
   * cut. Use `listLatestBySession` for the chat re-feed path so the
   * newest user turn always reaches the provider. Codex finding #3 in
   * ticket `01KQ2A5HTVG4WYFJE6RNP9D57G`. UI / archive / debug paths
   * keep the original semantics.
   */
  listBySession(sessionId: string, limit: number = 500): ConciergeMessage[] {
    const rows = this.db
      .prepare<[string, number], Row>(
        'SELECT * FROM concierge_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC LIMIT ?',
      )
      .all(sessionId, limit);
    return rows.map(rowToMessage);
  }

  /**
   * Latest-N rows for a session, returned oldest-first. The chat
   * tool-call loop replays this back to the provider; the newest
   * user message MUST be in the window or the provider has nothing
   * to answer. Implemented as DESC + LIMIT in a subquery so the
   * outer ORDER BY restores oldest-first ordering for the loop.
   *
   * Caveat: cutting the head of a session can produce a window that
   * starts mid tool-call sequence (e.g. the window opens on a
   * `role='tool'` row whose parent assistant + tool_calls is older
   * than the cap). `reconstructLLMHistory` defends against this by
   * dropping orphan tool rows when no preceding assistant turn is
   * paired. The trade-off is acceptable — losing some early context
   * beats losing the user's actual question.
   */
  listLatestBySession(
    sessionId: string,
    limit: number = 500,
  ): ConciergeMessage[] {
    const rows = this.db
      .prepare<[string, number], Row>(
        `SELECT * FROM (
           SELECT * FROM concierge_messages
           WHERE session_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?
         )
         ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId, limit);
    return rows.map(rowToMessage);
  }

  countSinceMidnightUtc(nowUtcMs: number = Date.now()): {
    count: number;
    spentUsd: number;
  } {
    const midnight = startOfUtcDay(nowUtcMs);
    const row = this.db
      .prepare<[number], { n: number; total: number }>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS total
           FROM concierge_messages WHERE created_at >= ?`,
      )
      .get(midnight);
    return { count: row?.n ?? 0, spentUsd: row?.total ?? 0 };
  }
}

export function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function startOfNextUtcDay(ms: number): number {
  return startOfUtcDay(ms) + 24 * 60 * 60 * 1000;
}
