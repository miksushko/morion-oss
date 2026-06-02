import { z } from 'zod';
import type { SubMoRole } from '../../../concierge/sub-mo-template.js';
import type { ComposeOpeningInput } from './types.js';
import { truncate } from './helpers.js';

/**
 * `composeOpening` — at workflow `human_gate` entry. Mo reads ticket
 * + recent comments + prior stage outputs + the workflow author's
 * `guidance` hint, then composes a 2-piece chat opening (summary line
 * + the specific question). Replaces the legacy static `stage.prompt`
 * text that was posted verbatim, bypassing Mo's role.
 */

const ComposeOpeningOutput = z.object({
  summary: z
    .string()
    .min(1)
    .max(800)
    .describe(
      'One sentence summarising the workflow run state for the user — what the agent did so far, what context matters. Plain prose; no headings, no markdown lists.',
    ),
  question: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "The specific question(s) the user must answer. PRIORITY RULE: when the prior stage output already contains explicit clarifying questions (a 'QUESTION:' prefix, a numbered list of questions, or any block where the agent explicitly defers a decision to the human), forward those questions verbatim — preserve their wording, numbering, A/B options, and ordering. Do NOT collapse multiple distinct questions into one. Only when the agent did NOT pre-formulate questions should Mo invent the question from context. In all cases, force a concrete decision-shaped prompt — never 'what would you like to do?'.",
    ),
});
export type ComposeOpeningOutput = z.infer<typeof ComposeOpeningOutput>;

export const composeOpeningRole: SubMoRole<ComposeOpeningOutput> = {
  name: 'mo-compose-chat-opening',
  purpose:
    "You are Mo, the project lead. The workflow paused at a human-in-the-loop point because progress requires a user decision. Your job: read the ticket context + recent activity + the workflow author's optional guidance hint, and compose a 2-piece chat opening — a short summary of where things stand and the specific question(s) the user needs to answer. CRITICAL: when the upstream agent already formulated explicit clarifying questions, you MUST forward those questions faithfully (verbatim wording, all of them, in order) — never paraphrase them into a single different question. The user replies in chat; Mo will route the workflow based on their answer.",
  schema: ComposeOpeningOutput,
  schemaDescription: `{
  "summary": string,   // 1-3 sentences. Plain prose. Tell the user what the agent did (or didn't do) and WHY it paused. Do NOT dump the agent's full output — only the headline.
  "question": string   // The questions block. If the agent's stage output contains explicit questions (QUESTION: prefix, numbered list like "Question 1: ... Question 2: ...", A/B options), reproduce them verbatim — same wording, same numbering, same options. Only invent the question from context when the agent left no explicit questions. Markdown lists ARE allowed here when the agent used them. 1-3 sentences if Mo invents; up to ~10 lines when forwarding the agent's verbatim block.
}`,
  extraRules: `
- Voice: confident project lead. Russian or English to match the ticket body's language.
- THE FIDELITY RULE (load-bearing, 2026-05-13):
  When the prior stage output contains a "QUESTION:" prefix, a numbered "Question 1: ... Question 2: ..." block, or any explicit handoff of a decision to the user (multiple choice / A or B / "should I X or Y"):
    * The "question" field MUST contain those questions verbatim — same words, same numbering, all of them.
    * Do NOT paraphrase, collapse, or pick "the most important one".
    * Do NOT invent a different question that you think is better.
    * The agent already did the thinking about what's actually undecidable — Mo's job is to relay, not to second-guess.
  When the agent's output has NO explicit questions, then Mo composes from context: a single specific decision-shaped prompt referencing concrete files / tradeoffs.
- Summary describes what just happened ("Pi read the codebase and surfaced 3 questions before writing any diff" / "Claude rewrote styles.css to switch the score panel layout but flagged a tradeoff about the legacy fallback"). It is NOT a restatement of the question.
- When the workflow author's "Guidance" field is set, treat it as additional framing — but the agent's verbatim questions still take precedence inside the question field. Guidance shapes Mo's summary tone, not the question content when the agent already asked.
- Never "What would you like to do?" / "How should I proceed?" — when Mo invents the question, force a real choice referencing concrete details.
`,
};

export function buildComposeOpeningScope(input: ComposeOpeningInput): string {
  const lines: string[] = [];
  lines.push(`# Ticket`);
  lines.push(`Title: ${input.ticketTitle}`);
  lines.push(``);
  lines.push(`Body:`);
  lines.push(truncate(input.ticketBody, 2000));
  if (input.recentComments && input.recentComments.trim().length > 0) {
    lines.push(``);
    lines.push(`# Recent comments (newest first)`);
    lines.push(truncate(input.recentComments, 2500));
  }
  if (input.priorStageOutputs && input.priorStageOutputs.trim().length > 0) {
    lines.push(``);
    lines.push(`# Prior stage outputs`);
    lines.push(truncate(input.priorStageOutputs, 2500));
  }
  if (input.guidance && input.guidance.trim().length > 0) {
    lines.push(``);
    lines.push(`# Guidance from workflow author (Mo MUST follow this hint literally)`);
    lines.push(input.guidance.trim());
  } else {
    lines.push(``);
    lines.push(
      `# Guidance: (none — Mo composes the question purely from context above)`,
    );
  }
  lines.push(``);
  lines.push(
    `Compose the chat opening per the schema. Remember: summary 1-3 sentences anchoring the user, question 1-2 sentences forcing a real choice.`,
  );
  return lines.join('\n');
}
