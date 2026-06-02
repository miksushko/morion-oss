/**
 * Direction V Phase V7.5 — expose every MCP tool to Mo in chat.
 *
 * Mo was previously limited to 7 read-only chat tools (CHAT_TOOLS in
 * chat-tools.ts). The user's request was "full MCP access by default,
 * gated only by per-folder / per-note permissions" — so we lean on
 * the existing MCP surface directly instead of maintaining a second
 * tool catalog.
 *
 * This module takes the server's `ALL_TOOLS` registry and:
 *   1. Converts each zod `inputShape` to a JSON Schema the LLM can
 *      consume (harmony-stripped for Groq compatibility — no
 *      `default`s, array-type unions flattened). See `mo-tools/schema.ts`.
 *   2. Dispatches each tool call back through the tool's own
 *      `handler(input, ctx)` so the canonical zod validation, audit
 *      logging, and `canPerform()` permission checks ALL still fire.
 *      See `mo-tools/dispatch.ts`.
 *   3. Serialises the result for the chat transcript with a hard
 *      byte budget — never slices mid-JSON. See `mo-tools/serialize.ts`
 *      + `mo-tools/trim.ts` (5 shape-aware trim branches).
 *
 * Permission story:
 *   - `ctx.actor = 'morion-concierge'` identifies Mo in audit_log and
 *     the canPerform() calls inside each handler. Pro-tier users can
 *     restrict Mo the same way they restrict other MCP clients
 *     (MCPPermissionsDialog). Free tier = unrestricted (the whole
 *     Pro-permission system is inert).
 *   - Archive gate still fires — archived notes + folders stay
 *     invisible to Mo by default.
 *
 * This file is a barrel only — see the sibling modules for code.
 */

export {
  buildMoToolDefinitions,
  type MoToolInvocation,
} from './mo-tools/schema.js';
export { dispatchMoTool } from './mo-tools/dispatch.js';
export {
  serializeMoToolResultForChat,
  type SerializedMoToolResult,
} from './mo-tools/serialize.js';
