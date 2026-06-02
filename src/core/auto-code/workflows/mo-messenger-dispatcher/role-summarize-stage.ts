import { z } from 'zod';
import type { SubMoRole } from '../../../concierge/sub-mo-template.js';
import type { SummarizeStageInput } from './types.js';
import { truncate } from './helpers.js';

/**
 * `summarizeStage` — at cli_agent `onStageEnd`. Mo reads the agent's
 * verbatim output and produces a 1-2 sentence "what happened" comment
 * for the ticket activity feed. Replaces the prior verbatim summary
 * block (which dumped the entire agent output into the comment
 * thread). The verbatim text still lives on the stage row's
 * `output.summary` for the drawer transcript.
 */

const SummarizeStageOutput = z.object({
  comment: z
    .string()
    .min(1)
    .max(600)
    .describe(
      "A 1-2 sentence comment for the ticket activity feed in Mo's voice. Describes what the agent produced in plain prose. NOT a copy of the agent's verbatim summary — a Mo-curated paraphrase that surfaces the essential outcome.",
    ),
});
export type SummarizeStageOutput = z.infer<typeof SummarizeStageOutput>;

export const summarizeStageRole: SubMoRole<SummarizeStageOutput> = {
  name: 'mo-summarize-stage',
  purpose:
    "You are Mo, the project lead. The cli_agent stage just finished. Your job: read the agent's verbatim output + the ticket context, and write a SHORT comment (1-2 sentences) that goes onto the ticket's activity feed in Mo's voice. The user reads dozens of these per workflow run — they should skim them, not dig in. The full agent output is preserved separately in the workflow drawer; this comment is just the headline.",
  schema: SummarizeStageOutput,
  schemaDescription: `{
  "comment": string   // 1-2 sentences. Plain prose. Lead with WHAT changed (files / behaviour), not WHO did it. Reference concrete details when possible ("touched styles.css to switch grid layout") over vague verbs ("made changes").
}`,
  extraRules: `
- 1-2 sentences hard cap. The activity feed has ~5 comments per run; this can't be a wall of text.
- LEAD with the change, not the actor. "Switched the score panel from 4-column grid to stacked layout" beats "Agent switched the score panel..."
- If the agent's output contains a QUESTION: prefix or otherwise explicitly hands off a clarification, surface that in the comment ("Agent surfaced a question about whether to drop the legacy fallback"). The next mo_stage decision will route to ask_human; this comment is the user's heads-up.
- If the agent failed / produced no diff / hit budget, say so in plain words ("Agent hit a budget cap before producing a fix; nothing committed").
- NEVER lie about what happened. Mo's credibility is the whole product.
`,
};

export function buildSummarizeStageScope(input: SummarizeStageInput): string {
  const lines: string[] = [];
  lines.push(`# Ticket`);
  lines.push(`Title: ${input.ticketTitle}`);
  lines.push(``);
  lines.push(`Body excerpt:`);
  lines.push(truncate(input.ticketBody, 800));
  lines.push(``);
  lines.push(`# Stage that just finished`);
  lines.push(`Stage id: ${input.stageId}`);
  lines.push(`Agent: ${input.agentName ?? '(unknown)'}`);
  lines.push(`Terminal status: ${input.terminalStatus}`);
  lines.push(``);
  lines.push(`# Agent's verbatim summary`);
  lines.push(truncate(input.agentSummary, 4000));
  lines.push(``);
  lines.push(
    `Write the 1-2 sentence comment per the schema. Lead with the change. If the agent surfaced a question or failed, say so plainly.`,
  );
  return lines.join('\n');
}
