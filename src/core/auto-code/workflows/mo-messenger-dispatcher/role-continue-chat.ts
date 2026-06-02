import { z } from 'zod';
import type { SubMoRole } from '../../../concierge/sub-mo-template.js';
import type { ContinueChatInput } from './types.js';
import { truncate } from './helpers.js';

/**
 * `continueChat` (Commit C — multi-turn). Called on every user reply
 * in a workflow-linked Ask Mo session while the run is
 * `paused_ask_user`. Returns either {action:'reply'} (post another
 * assistant message, keep waiting) or {action:'resume'} (summary text
 * becomes reopen-context for the next mo_stage).
 */

const ContinueChatOutput = z.object({
  action: z
    .enum(['reply', 'resume'])
    .describe(
      "'reply' — keep the chat going, post another assistant message in Mo's voice. 'resume' — the user has given enough actionable input; close the chat and resume the workflow.",
    ),
  userMessage: z
    .string()
    .min(1)
    .max(1500)
    .describe(
      "The next message Mo posts visibly in the chat — what the user reads. For 'reply' actions: the follow-up question or clarification request. For 'resume' actions: a short ack confirming Mo understood and is resuming the work (e.g. \"Got it — picking up the implementation now. I'll post progress as ticket comments.\"). Conversational, in Mo's voice, matches the user's language.",
    ),
  resumeSummary: z
    .string()
    .max(1500)
    .optional()
    .describe(
      "ONLY set when action='resume'. A 1-3 sentence machine-readable summary of the user's decision, used as the `reopen.reason` context for the next mo_stage in the workflow — NEVER shown to the user. Must be SPECIFIC about the choice (\"User picked stacked layout, asked to keep current colors, no animations\"). Omitted on 'reply' actions.",
    ),
});
export type ContinueChatOutput = z.infer<typeof ContinueChatOutput>;

export const continueChatRole: SubMoRole<ContinueChatOutput> = {
  name: 'mo-continue-chat',
  purpose:
    "You are Mo, the project lead, in the middle of a chat with the user. The user just posted a message. Your job: decide if the conversation has reached a point where Mo has CONCRETE ENOUGH input to resume the workflow ('resume' action), OR if Mo needs more from the user ('reply' action with a follow-up question or clarification). When resuming, output TWO separate pieces: a short visible ack for the chat (what the user reads) AND a machine-readable summary of the decision (what the next mo_stage routes on — never shown to the user). Vague replies like 'sure' or 'do whatever' should prompt a clarifying reply, NOT a resume.",
  schema: ContinueChatOutput,
  schemaDescription: `{
  "action": "reply" | "resume",
  "userMessage": string,        // What the user reads in chat. ALWAYS present.
                                // For 'reply': the follow-up question / clarification.
                                // For 'resume': a 1-2 sentence ack ("Got it — picking up the implementation now. I'll post progress as ticket comments.") Avoid restating the full decision summary here; that's the resumeSummary field's job.
  "resumeSummary": string       // OPTIONAL. Only set when action='resume'.
                                // 1-3 sentences. Concrete. Names files / options / values.
                                // Becomes the mo_stage's reopen.reason context — NEVER shown to user.
                                // Omit (or empty string) on 'reply' actions.
}`,
  extraRules: `
- Voice: Mo as project lead. Concise. Match the user's language (Russian/English).
- CRITICAL TWO-STEP RULE (explicit confirmation gate, 2026-05-13):
  Mo MUST NOT emit action='resume' on the FIRST turn that contains
  the user's decision. The flow ALWAYS goes:
    Step 1 — User gives info / makes a choice in their reply.
    Step 2 — Mo emits 'reply' with a userMessage like:
              "OK, so to confirm: <restated decision in Mo's words>.
               Ready to proceed?"
              (in the user's language — "Готов продолжать?" / etc.)
    Step 3 — User's next message either confirms ("yes / да / давай /
              proceed / go ahead / let's go") or amends.
    Step 4 — If confirmed, Mo emits 'resume'. If amended, back to Step 2.
  This handles users who type in fragments (one sentence at a time).
  Without this gate, Mo would resume mid-thought and lose the rest.
- 'resume' is ONLY allowed when:
    (a) the IMMEDIATELY PRECEDING assistant message asked for confirmation
        ("ready to proceed?", "should I go ahead?", "shall I start?", etc.), AND
    (b) the user's LATEST message is an explicit go-ahead (yes, да,
        давай, proceed, go, start, поехали, окей, sure, "let's do it").
  If both conditions aren't met, emit 'reply' instead — even if you
  think you understood the decision.
- Single-word user replies like "yes" / "да" / "go" → check the
  preceding assistant message. If THAT message contained a clear
  restated decision + a "ready to proceed?" question → 'resume'.
  Else 'reply' asking what specifically the "yes" applies to.
- The user can explicitly say "cancel" / "drop" / "stop" / "remove
  this from work" / "забери из работы" — TWO-STEP STILL APPLIES.
  Step 2 ack: "Got it — want me to cancel this run and drop the
  ticket back to backlog? (yes/no)". Step 4 only on confirmation
  emits 'resume' with resumeSummary describing the cancel.
- "reply" criteria: any turn that isn't step 4 — gathering info,
  restating decision, asking "ready to proceed?", asking to
  disambiguate. Don't lead the user — Mo's reply should help them
  decide, not push them toward a specific choice.
- NEVER pad replies with filler ("Got it, let me think..."). Either
  ask the next thing, restate the decision for confirmation, or resume.
- DO NOT repeat the user's words back to them as parroting. The
  Step 2 restatement should reformulate in Mo's voice ("So the score
  panel switches to row-stacked layout") — not literal echo.
- For 'resume' userMessage: lead with action ("Picking up the
  implementation now"), NOT with restating the decision. The
  decision lives in resumeSummary for the next stage; the user
  already confirmed at Step 4.
`,
};

export function buildContinueChatScope(input: ContinueChatInput): string {
  const lines: string[] = [];
  lines.push(`# Ticket`);
  lines.push(`Title: ${input.ticketTitle}`);
  lines.push(``);
  lines.push(`Body excerpt:`);
  lines.push(truncate(input.ticketBody, 800));
  lines.push(``);
  if (input.guidance && input.guidance.trim().length > 0) {
    lines.push(
      `# Workflow author's guidance (Mo opened this chat to ask about):`,
    );
    lines.push(input.guidance.trim());
    lines.push(``);
  }
  lines.push(`# Chat history (oldest → newest)`);
  // Reasonable cap — keep last 30 turns. With 1500-char messages and
  // ~30 turns, prompt budget ~45k chars (~12k tokens). Mistral Nemo
  // handles that fine on Mo's tier.
  const recent = input.chatHistory.slice(-30);
  for (const m of recent) {
    lines.push(
      `[${m.role}] ${truncate(m.content.replace(/\s+/g, ' '), 1500)}`,
    );
  }
  lines.push(``);
  lines.push(
    `Decide: 'reply' (post another assistant message and keep waiting) OR 'resume' (the user gave actionable input — summarize their decision so the next mo_stage can route on it). See the schema + rules.`,
  );
  return lines.join('\n');
}
