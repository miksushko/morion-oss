/**
 * Direction V — Chat-side approval prompts for destructive tool calls.
 *
 * When Mo's chat tool-call loop emits a tool whose `category === 'delete'`,
 * the server pauses the loop instead of dispatching. A "pending tool"
 * marker lands in `concierge_messages` (encoded inside an `assistant`
 * row's content via the sentinel below — no schema migration needed).
 * The UI detects the sentinel, renders an approval card with
 * Approve / Deny buttons. The follow-up `/tool-approve` endpoint reads
 * the pending payload, dispatches the originally-requested tool calls
 * (or synthesises a `user_denied` result), persists the tool result
 * rows, and re-enters the chat loop so Mo can react.
 *
 * Sentinel-on-content mirrors the `__MO_NOT_CONFIGURED__` pattern
 * used elsewhere in the chat path. CLAUDE.md core/web boundary
 * forbids sharing constants across `src/core` and `src/web`, so the
 * UI maintains its own copy of the marker string.
 */

export const PENDING_TOOL_MARKER = '__MO_PENDING_TOOL_APPROVAL__';

/**
 * Single tool call captured in the pending payload. Mirrors the
 * structure the LLM provider returned + IDs we need to attach tool
 * result rows after dispatch.
 */
export interface PendingToolCall {
  id: string;
  name: string;
  argumentsJson: string;
  /**
   * Human-readable label for the target the tool would mutate.
   * Populated server-side when the call is destructive — looks up the
   * note title / folder name / tag name behind the ID in args so the
   * UI can show "Delete note 'Project spec'" instead of a raw ULID.
   * Optional + may be undefined on:
   *   - non-destructive calls (UI doesn't surface them)
   *   - destructive calls whose target was deleted between Mo
   *     emitting the call and the server persisting the pending row
   *     (rare; UI falls back to the raw args display).
   */
  displayLabel?: string;
}

/**
 * Persisted JSON inside a pending-tool message. Carries everything we
 * need to resume the chat loop after the user clicks Approve / Deny.
 *
 *   - `preface`: any `content` text the LLM emitted alongside the tool
 *     calls. Surfaces in the approval card as Mo's explanation.
 *   - `toolCalls`: ALL tool calls Mo emitted in this turn (destructive
 *     and not). On approve we dispatch each in order; on deny we synth
 *     `user_denied` for the destructive subset and dispatch the rest.
 *   - `destructiveCallIds`: the subset of toolCalls.id that triggered
 *     the pause. Lets the UI label "Mo wants to delete X, Y" precisely.
 *   - `model`: provider model id, kept so the resumed turn's audit row
 *     credits the right model.
 */
export interface PendingToolPayload {
  preface: string;
  toolCalls: PendingToolCall[];
  destructiveCallIds: string[];
  model: string | null;
}

export function formatPendingToolMessage(payload: PendingToolPayload): string {
  // Newline after the marker so JSON pretty-prints don't visually
  // collide. Parser is loose — only the prefix matters.
  return `${PENDING_TOOL_MARKER}\n${JSON.stringify(payload)}`;
}

export function isPendingToolMessage(content: string): boolean {
  return content.startsWith(PENDING_TOOL_MARKER);
}

export function parsePendingToolMessage(content: string): PendingToolPayload | null {
  if (!isPendingToolMessage(content)) return null;
  const tail = content.slice(PENDING_TOOL_MARKER.length).replace(/^\s+/u, '');
  try {
    const parsed = JSON.parse(tail) as PendingToolPayload;
    if (!Array.isArray(parsed.toolCalls)) return null;
    if (!Array.isArray(parsed.destructiveCallIds)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Tools where `category === 'delete'` require user approval before
 * dispatch in chat mode. `notes_update` / `tasks_move` / every
 * `update`-category tool is Mo's job — audit log + revisions are the
 * safety net, prompting for every move kills the workflow. Operator
 * decision 2026-04-25.
 *
 * The function takes the full tool registry so the caller doesn't
 * have to import ALL_TOOLS into core (web/server boundary).
 */
export function isMoApprovalRequired(
  toolName: string,
  registry: ReadonlyArray<{ name: string; category: string }>,
): boolean {
  const def = registry.find((t) => t.name === toolName);
  if (!def) return false;
  return def.category === 'delete';
}

/**
 * Synthetic tool-result envelope used when the user denies a destructive
 * call. Mirrors the shape `dispatchMoTool` returns on a real handler
 * error, so the LLM treats it as "the call was rejected" without any
 * special-case code in the prompt.
 */
export function deniedToolResult(reason: string | null): Record<string, unknown> {
  return {
    error: 'user_denied',
    message: reason && reason.trim().length > 0
      ? `User denied this tool call: ${reason.trim().slice(0, 500)}`
      : 'User denied this tool call.',
  };
}
