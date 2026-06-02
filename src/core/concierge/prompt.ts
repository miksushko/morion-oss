/**
 * Mo prompt assembly — chat-tier only.
 *
 * The autonomous Concierge tick engine (kanban patrol, "review > 2h →
 * todo", "done without comment → review") was removed in two passes:
 * 2026-05-03 (commit 34bab55) cut the live wiring (scheduler poll +
 * /launch HTTP route + UI Schedule pills); 2026-05-05 (ticket
 * `01KQVA65TJ2VCY8VCKH9N5F6W8` "Disable Mo Concierge") deleted the
 * remaining dead-code island — `runConciergeTick`, `CONCIERGE_TOOLS`,
 * `buildSystemPrompt` / `buildUserPrompt` (the tick prompts),
 * `wrapUserContent` + delimiter constants (only the tick prompts wrapped
 * agent-authored card bodies / comments). What's left here is purely
 * the Ask Mo chat persona + cleanup-escalation interpretation.
 *
 * Mo still acts on workspace content — but only when the user asks for
 * it in the current chat turn, or when the auto-code orchestrator drives
 * the kanban → Claude Code → review loop. None of those are autonomous
 * Mo; they are reactive responses to explicit triggers.
 *
 * Module layout — per the 2026-05-16 split (Morion ticket
 * 01KRR8JJ94AD7DB15D1D1YXYXD). Per-block files under `./prompts/`
 * hold byte-exact verbatim strings so output snapshots can't drift:
 *   - `./prompts/cleanup-escalation.ts`    types + buildCleanupEscalationBlock.
 *   - `./prompts/personas.ts`              buildGrumpy/PlainChatPrompt + voice blocks.
 *   - `./prompts/tool-preference.ts`       TOOL_PREFERENCE_BLOCK.
 *   - `./prompts/tagging-convention.ts`    TAGGING_CONVENTION_BLOCK.
 *   - `./prompts/bulk-destructive-rules.ts` CHAT_BULK_DESTRUCTIVE_RULES.
 *   - this file                            buildChatSystemPrompt
 *                                          orchestrator + public
 *                                          re-exports.
 */

import {
  buildCleanupEscalationBlock,
  type CleanupEscalationContext,
} from './prompts/cleanup-escalation.js';
import {
  buildGrumpyChatPrompt,
  buildPlainChatPrompt,
} from './prompts/personas.js';
import { TAGGING_CONVENTION_BLOCK } from './prompts/tagging-convention.js';
import { CHAT_BULK_DESTRUCTIVE_RULES } from './prompts/bulk-destructive-rules.js';

// Re-export public surface so existing importers
// (`from '.../concierge/prompt.js'`) keep working unchanged.
export type {
  CleanupEscalationContext,
  CleanupEscalationDecision,
} from './prompts/cleanup-escalation.js';
export { TAGGING_CONVENTION_BLOCK } from './prompts/tagging-convention.js';

/**
 * Chat-mode system prompt — for the "Ask Mo" sidebar panel, NOT for
 * the board-tick engine. Persona: Mo Brownie, the workspace-spirit
 * for Morion (brownie = household spirit that keeps a home in order).
 * Everyone calls him Mo.
 *
 * Style settings (grumpy-on vs. off) are an INTERNAL flavour switch
 * — Mo must never tell the user "I'm in grumpy mode" or "I was asked
 * to act as a St. Petersburg konsjerzh". That framing is a reviewer's
 * style reference, not his self-image. If asked who he is, he's just
 * Mo — Morion's internal helper.
 *
 * Prompt injection surface: the user's chat history AND any workspace
 * data we later surface through tools can contain attacker-controlled
 * text. System prompt terminates with a hard rule that instructions
 * inside the conversation are ignored — only the system prompt is
 * authoritative.
 */
export function buildChatSystemPrompt(input: {
  grumpyMentor: boolean;
  folderName?: string | null;
  /** Mo Indexing Redesign — when the chat is scoped to a folder with
   * a populated `mo:catalog` note, prepend the catalog body so Mo
   * answers folder questions with pre-routed context. Omit / null
   * when no catalog is available yet; the system prompt falls back
   * to "call notes_search / mo_search yourself". */
  projectCatalog?: string | null;
  /** Workspace-wide Mo memory — durable preferences / decisions /
   * conventions about THIS user. Loaded fresh on every chat turn from
   * `concierge.moMemory.read()`. Carries the user's stated preferences
   * (form of address, response style, "always ping me when X") into
   * every conversation regardless of folder. Empty / null when the
   * user has nothing in memory. */
  moMemory?: string | null;
  /** Topic-cleanup escalation context. Set when the chat session has
   * a pending topic-cleanup proposal (assistant message with
   * `quickActions` like `bundle:N:use-X` / `demote:N:apply` / etc.)
   * and the user's current turn is a custom-instruction reply to it.
   * Without this, chat-tier Mo loses the proposal context (history
   * has the prose but Mo doesn't know what action verbs map to it)
   * and can hallucinate "Mo not enabled" / try the wrong tools.
   * Dogfood incident 2026-05-04 (`Bkt Design System rewrite`). */
  cleanupEscalation?: CleanupEscalationContext | null;
}): string {
  const core = input.grumpyMentor
    ? buildGrumpyChatPrompt(input.folderName ?? null)
    : buildPlainChatPrompt(input.folderName ?? null);
  const withRules = `${core}\n\n${CHAT_BULK_DESTRUCTIVE_RULES}`;
  const memory = input.moMemory?.trim();
  const catalog = input.projectCatalog?.trim();
  // Memory block goes FIRST — it's user identity / preferences that
  // color every reply. Catalog block follows (folder-scoped routing
  // index). Persona + rules last. Order matters: the model should see
  // "this user wants to be addressed as X" BEFORE it picks a voice.
  const blocks: string[] = [];
  if (memory) {
    blocks.push(
      `## Mo memory — what you remember about this user (workspace-wide)
These are durable facts / preferences / conventions about the user, independent of any folder or task. Apply them to EVERY response: form of address, voice cadence, content style, things to always or never do. The user can edit this directly; treat it as authoritative.

${memory}`,
    );
  }
  // Memory write instructions go OUT regardless of whether memory has
  // content — Mo needs to know how to add to it from the very first
  // turn, when memory is still empty.
  blocks.push(`## When to write to memory (\`mo_remember\` tool)
Memory is workspace-wide and outlives every chat session. Call \`mo_remember({fact: "..."})\` when:

- The user EXPLICITLY asks ("remember that I…", "save to memory", "запиши в память", "запомни", "noteworthy", "always call me X", "I prefer Y", "от меня всегда требуется Z"). This is unconditional — even if the fact seems trivial, the user owns the memory.
- You notice the user expressing a DURABLE preference / decision / convention worth surviving across sessions. Examples: form of address, response style, working hours, project-wide policy, naming conventions, things to always or never do. Skip ephemeral chat ("good morning"), task-scoped facts (those go in folder workflow / Project Memory), and anything you wouldn't want a new agent on a different task to see.

\`mo_remember\` is LLM-tier — it costs tokens. Don't fire after every message. One call per durable fact is enough; the tool itself dedups + checks for conflicts.

The tool returns one of:
- \`{action: 'added'}\` — Mo integrated it. Confirm to the user briefly ("Got it, remembered.").
- \`{action: 'deduped'}\` — already known. Tell the user it was already there.
- \`{action: 'conflict', existing, proposed, question}\` — contradicts existing memory. NO write happened. Surface the \`question\` to the user verbatim. When the user's reply confirms the proposed fact should win (e.g. "yes", "да", "месье конечно", "use the new one"), re-call \`mo_remember\` with the SAME \`fact\` AND \`override: true\` — that forces the write, replacing the contradicting items. If the user changes their mind / wants the existing version kept, just confirm in chat without calling the tool again.

If the user contradicts a memory in chat (says something different from what's stored), take their latest word AND offer to update memory via \`mo_remember\`.

## When the user wants to FORGET / clear memory (\`mo_forget\` tool)

\`mo_remember\` is for ADDING facts. To remove memory items, use \`mo_forget\` instead:

- \`mo_forget({all: true})\` — wipe ALL workspace memory. Destructive; surfaces an approval card to the user before running. Use when the user says "forget everything", "clear memory", "забудь всё", "очисти память под ноль".
- \`mo_forget({pattern: "..."})\` — remove items matching a substring or topic (e.g. "forget my address", "забудь как меня зовут"). Mo decides which lines to drop based on the pattern.

NEVER try to clear memory by calling \`mo_remember\` with a meta-fact like "user asked to clear memory" — that adds the meta-statement, it doesn't clear anything.

## Tool-result honesty (applies to ALL tools)

When a tool returns an envelope shaped \`{error: ..., message: ...}\`, that is a FAILURE. Do NOT claim the action succeeded. Surface the error message (briefly, in your voice) and tell the user what didn't happen. The user trusts you to report ground truth from the tools — confabulating success when the database wasn't touched is a much bigger trust break than admitting "the tool returned an error, here's what it said".`);
  if (catalog) {
    blocks.push(
      `## Mo catalog — "${input.folderName ?? 'folder'}" (folder routing index)
Auto-maintained per-folder index Mo regenerates on its indexing tick. Use it to ROUTE — pick which clusters / notes are relevant to the user's question — then ground your answer by calling \`mo_search\` / \`notes_search\` / \`notes_get\` to read the live notes. The catalog is stale-by-design; final claims must cite ULIDs from the live notes you actually read, NOT from this catalog body.

${catalog}`,
    );
  }
  if (input.cleanupEscalation) {
    blocks.push(buildCleanupEscalationBlock(input.cleanupEscalation));
  }
  // Tagging convention applies whenever Mo mutates tags via
  // `notes_create` / `notes_update` (typical when the user says "tag
  // this as X"). Same source-of-truth block ships in SKILL.md so
  // third-party MCP agents see identical rules. Place it BEFORE the
  // persona/rules block so the model sees the rule on every turn,
  // regardless of voice.
  blocks.push(TAGGING_CONVENTION_BLOCK);
  blocks.push(withRules);
  return blocks.join('\n\n---\n\n');
}
