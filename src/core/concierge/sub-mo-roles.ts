import { z } from 'zod';
import type { SubMoRole } from './sub-mo-template.js';

/**
 * Phase 4 — context restructure ticket `01KQFQ1RJV7EH0X3WF2H1A476J`.
 *
 * Catalogue of sub-Mo role definitions used by the deep-context-gather
 * engine. Each role declares:
 *   - `name`: stable id (logs, audit, telemetry)
 *   - `purpose`: prompt header that frames the work
 *   - `schema`: Zod validator for the parsed JSON output
 *   - `schemaDescription`: hand-written prose schema for the prompt
 *     (more readable than zod-to-json-schema autogen + lets us include
 *     per-field guidance the model needs)
 *   - `extraRules?`: role-specific instructions appended to HARD_RULES
 *
 * Phase 4 ships the infrastructure + 2 demonstration roles
 * (`keyword-generator`, `body-extractor`). Phase 7 (gather engine) adds
 * `task-cluster-analyst`, `folder-router`, `folder-analyst`, and
 * `workspace-search-worker` as the engine wires them in. Adding a role
 * later is one new exported `SubMoRole<T>` constant — no changes to
 * `runSubMoTask` / `runSubMoBatch`.
 */

// ---------------------------------------------------------------------
// keyword-generator
// ---------------------------------------------------------------------

export const KeywordGeneratorOutput = z.object({
  /** Search keywords distilled from the input. Each is a single word
   *  or a tight 2-3-word phrase agents would actually type into a
   *  search box. Lowercased, no punctuation. */
  keywords: z.array(z.string().min(1)).min(0).max(20),
});

export type KeywordGeneratorOutput = z.infer<typeof KeywordGeneratorOutput>;

export const keywordGeneratorRole: SubMoRole<KeywordGeneratorOutput> = {
  name: 'keyword-generator',
  purpose:
    'Read the user\'s task or question and emit a small set of search keywords (single words or 2-3-word phrases) that an FTS+vector index would use to surface relevant notes from the workspace.',
  schema: KeywordGeneratorOutput,
  schemaDescription: `{
  "keywords": string[]   // 4-12 lowercase keywords / short phrases. Pick concrete nouns, file paths, API names, error strings — NOT generic verbs or function words. Include both surface forms and synonyms when applicable (e.g. "stripe", "webhook", "idempotency", "event-id").
}`,
  extraRules: `
- Output between 4 and 12 keywords. Fewer = under-recall; more = noise that dilutes ranking.
- Strip punctuation. "Stripe webhook idempotency" → "stripe webhook idempotency" (3 keywords).
- Skip stopwords (the / and / for / how) and pure verbs (implement / fix / add).
- Prefer concrete domain terms (Stripe, webhook, FTS5, ULID) over abstract concepts (security, performance) UNLESS the latter is the question.
`,
};

// ---------------------------------------------------------------------
// body-extractor
// ---------------------------------------------------------------------

export const BodyExtractorOutput = z.object({
  /** Verbatim quote-able chunks from the supplied note body that
   *  speak to the agent's question. Keep each chunk short (1-3
   *  sentences). Empty array = note isn't relevant after all. */
  chunks: z.array(z.string().min(1)).min(0).max(8),
  /** One-line synthesis of WHY this note matters for the question.
   *  Empty string = note is unrelated. */
  why: z.string().max(400),
  /** True when the note explicitly contradicts something the agent
   *  is about to do (e.g. "we tried this approach in 2024 and it
   *  caused a regression"). Surfaces in the final packet's "risks"
   *  section. */
  isWarning: z.boolean(),
});

export type BodyExtractorOutput = z.infer<typeof BodyExtractorOutput>;

export const bodyExtractorRole: SubMoRole<BodyExtractorOutput> = {
  name: 'body-extractor',
  purpose:
    'Read ONE note body in the context of an agent\'s task or question. Extract the chunks that genuinely matter, explain in one line why the note is relevant, and flag explicit warnings/contradictions.',
  schema: BodyExtractorOutput,
  schemaDescription: `{
  "chunks": string[],   // 0-8 short verbatim quotes from the note body that bear on the question. Empty array if nothing in this note is actually relevant.
  "why": string,        // <=400 chars. One sentence answering "why does the agent need to read this note?". Empty string if not relevant.
  "isWarning": boolean  // true when the note explicitly contradicts the agent's intended approach (past failure, known regression, "don't do X")
}`,
  extraRules: `
- Be ruthless about relevance. If the note is a near-miss / topic-adjacent but doesn't answer the question, return empty chunks + empty why + isWarning=false. Better to under-surface than to dilute the synthesis.
- Quote chunks VERBATIM from the note body. Do not paraphrase. The downstream synthesiser cites your chunks.
- "isWarning: true" should be rare — reserve for explicit "we tried X and it broke" content, not generic "be careful with X".
`,
};

// ---------------------------------------------------------------------
// task-cluster-analyst (Phase 7 — gather engine Wave 1)
// ---------------------------------------------------------------------

export const TaskClusterAnalystOutput = z.object({
  /** Note ids the analyst flagged as worth opening (Wave 2 will read
   *  bodies). Limited per call to keep the body-read budget in check. */
  drillIntoNoteIds: z.array(z.string()).max(10),
  /** Plain-language explanation Mo will surface in the final packet's
   *  "why these notes matter" section. Empty string when nothing
   *  actionable was found in this cluster. */
  why: z.string().max(500),
});

export type TaskClusterAnalystOutput = z.infer<typeof TaskClusterAnalystOutput>;

export const taskClusterAnalystRole: SubMoRole<TaskClusterAnalystOutput> = {
  name: 'task-cluster-analyst',
  purpose:
    'You are scanning ONE cluster of related tasks/notes in the same project as the agent\'s current task. Your job is to pick which tasks are worth opening (their bodies will be read in the next step) and explain why.',
  schema: TaskClusterAnalystOutput,
  schemaDescription: `{
  "drillIntoNoteIds": string[],   // 0-10 note ids from the cluster's task list. Pick only ids that are actually likely to inform the agent's task. Empty array = "nothing in this cluster is worth opening".
  "why": string                   // <=500 chars. One paragraph explaining the connection. "These tasks share the Stripe webhook idempotency pattern and one of them documents the dedupe approach." Empty string when drillIntoNoteIds is empty.
}`,
  extraRules: `
- Be selective. drillIntoNoteIds is a budget — picking 10 means we burn 10 body-extractor calls. Default to 2-4 unless the cluster is large and topical.
- If the cluster's tasks are tangentially related but don't directly inform the agent's task, return empty drillIntoNoteIds + empty why. Better to under-recall.
- Note ids in the cluster's task list are the ONLY valid output. Do NOT invent ids.
`,
};

// ---------------------------------------------------------------------
// gather-synthesizer (Phase 7 — gather engine final synth step)
// ---------------------------------------------------------------------

export const GatherSynthesizerOutput = z.object({
  /** Markdown packet body — the human-/agent-readable narrative. The
   *  caller renders this directly in the response. */
  packetMarkdown: z.string().min(1).max(20000),
  /** Structured ids cited in the packet so the caller can attach
   *  per-id deeplinks / further reads. */
  citedNoteIds: z.array(z.string()).max(50),
  /** Free-form risks / "watch out for" notes Mo wants the agent to
   *  see prominently. Empty array when nothing flagged. */
  risks: z.array(z.string().max(500)).max(10),
});

export type GatherSynthesizerOutput = z.infer<typeof GatherSynthesizerOutput>;

export const gatherSynthesizerRole: SubMoRole<GatherSynthesizerOutput> = {
  name: 'gather-synthesizer',
  purpose:
    'You are the central synthesizer for a deep-context-gather call. You receive the agent\'s task + structured findings from N parallel sub-Mo workers, and you compose ONE markdown packet that gives the agent everything they need to start work.',
  schema: GatherSynthesizerOutput,
  schemaDescription: `{
  "packetMarkdown": string,   // The full markdown packet. Sections recommended: ## Task summary, ## Relevant prior work (cite note ids), ## Risks / things to watch, ## Suggested next steps. Keep concise — 8-15 paragraphs is plenty for most calls.
  "citedNoteIds": string[],   // Every note id you reference in packetMarkdown. The caller uses this to attach links + verify the synthesis grounded on real notes.
  "risks": string[]           // 0-10 short risk strings the agent should pay attention to. Pulled out of the markdown so the UI can highlight them. Each <=500 chars.
}`,
  extraRules: `
- Cite note ids verbatim using the format \`[noteId]\` (square brackets) so they're machine-extractable. Example: "The dedupe pattern from [01HABC123] is the canonical reference."
- Do NOT invent note ids. Cite only ids actually present in the sub-Mo findings the user message lists.
- Be honest about gaps. If sub-Mos returned nothing relevant, say "Mo couldn't find prior work on this in the indexed material" — don't fabricate plausible-sounding context.
- Risks include: explicit warnings sub-Mos flagged, contradictions between findings, things-this-task-touches-that-have-broken-before. Skip generic safety boilerplate.
`,
};
