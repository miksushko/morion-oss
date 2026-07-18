import { WorkflowDefinitionSchema, type WorkflowDefinition } from './types/index.js';
import { LinearWorkflowError, parseRunnableWorkflow } from './parse-linear.js';

/**
 * `mo_build_workflow` drafting engine — Mo authors a WorkflowDefinition
 * from a natural-language instruction (Mo Workflows epic).
 *
 * Deterministic guard-railed loop, NOT a fire-and-forget smart-write
 * (the mo_record lesson): the LLM only ever produces a DRAFT; every
 * draft runs the exact save-time validation stack, and validation
 * issues feed back into the next attempt. The caller (the MCP tool)
 * decides whether anything gets written.
 *
 * Framework-free: takes an `LLMProvider`-shaped `complete` dependency
 * so tests inject a fake provider.
 */

export interface BuildWorkflowProvider {
  complete(req: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    temperature?: number;
  }): Promise<{ content: string; costUsd: number }>;
}

export interface BuildWorkflowArgs {
  provider: BuildWorkflowProvider;
  primaryModel: string;
  /** Empty string → single-model mode (no fallback attempt). */
  fallbackModel: string;
  /** The user's natural-language description of the desired process. */
  instruction: string;
  /** Optional base definition to modify instead of authoring from zero. */
  baseDefinition?: WorkflowDefinition | null;
  /** Attempt cap across primary + fallback. Default 3. */
  maxAttempts?: number;
}

export interface BuildWorkflowIssue {
  path: string;
  message: string;
}

export type BuildWorkflowResult =
  | {
      ok: true;
      definition: WorkflowDefinition;
      runnable: boolean;
      runnableReason: string | null;
      costUsd: number;
      attempts: number;
      modelUsed: string;
    }
  | {
      ok: false;
      error: 'workflow_draft_failed';
      message: string;
      issues: BuildWorkflowIssue[];
      costUsd: number;
      attempts: number;
    };

/** Compact schema + invariant briefing. Content mirrors the
 *  morion-workflows skill references — enough for a strong model to
 *  emit valid JSON on the first or second attempt. */
const SYSTEM_PROMPT = [
  'You author Morion Auto-code WorkflowDefinition JSON. Reply with ONE',
  'JSON object and NOTHING else — no prose, no markdown fences.',
  '',
  'Shape: {"schemaVersion": 1, "name": string, "description": string,',
  '"stages": [...], "edges": [{"from", "to", "on"}]}.',
  '',
  'Stage kinds:',
  '- cli_agent: {id, kind, agent: "claude"|"codex"|"pi"|"opencode",',
  '  promptTemplate (Mustache over {{ticket.title}}/{{ticket.id}}/',
  '  {{ticket.body}}/{{ticket.recentComments}}/{{stages.<id>.output.summary}}/',
  '  {{reopen.reason}}), maxBudgetUsd, maxAttempts, allowedTools',
  '  (["Read","Write","Edit","Glob","Grep","Bash"] subset), optional',
  '  fallbackAgent/provider/model/level.',
  '- mo_stage: {id, kind, instruction, branches (>=2 unique strings),',
  '  postComment: true, isStart (exactly ONE stage true), allowedTools: []}.',
  '- human_gate: {id, kind, guidance?} — exactly one outbound edge.',
  '- mcp_tool_call: {id, kind, toolName, argsTemplate, maxAttempts}.',
  '- reject_sink / complete_sink: {id, kind, commentTemplate: ""} —',
  '  exactly one of EACH, no outbound edges.',
  'Never use: mo_router, eject (deprecated), branch (not runnable).',
  '',
  'Hard invariants (validation rejects violations):',
  '1. Unique stage ids; every edge endpoint exists.',
  '2. Exactly one mo_stage with isStart: true.',
  '3. Exactly one reject_sink and one complete_sink; sinks have no',
  '   outbound edges.',
  "4. Every outbound edge of a mo_stage carries on=<one of that stage's",
  '   branches>; at most one edge per label. cli_agent stages advance',
  '   with on="success".',
  '5. Both sinks must be reachable from the start stage (back-edges for',
  '   reopen loops are allowed).',
  '6. Do not invent fields — unknown keys fail.',
  '',
  'Model ids: leave "model" null unless the instruction names one.',
].join('\n');

function extractJson(content: string): unknown {
  const text = content.trim();
  const candidates: string[] = [];
  // Fenced block first — but definitions legitimately contain ```
  // inside promptTemplate strings, which truncates a non-greedy fence
  // match. So the fence is only a CANDIDATE; the widest brace window
  // over the whole text is the robust fallback.
  const fenced = text.match(/```(?:jsonc?)?\s*\n([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]!.trim());
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  throw new Error('no parseable JSON object found in model output');
}

function validateDraft(
  candidate: unknown,
):
  | { ok: true; definition: WorkflowDefinition; runnable: boolean; runnableReason: string | null }
  | { ok: false; issues: BuildWorkflowIssue[] } {
  const parsed = WorkflowDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.') || 'definition',
        message: i.message,
      })),
    };
  }
  try {
    parseRunnableWorkflow(parsed.data);
    return { ok: true, definition: parsed.data, runnable: true, runnableReason: null };
  } catch (err) {
    if (err instanceof LinearWorkflowError) {
      // Saveable draft, not dispatchable (e.g. a `branch` stage) —
      // surface but don't fail the build; the caller decides.
      return {
        ok: true,
        definition: parsed.data,
        runnable: false,
        runnableReason: err.message,
      };
    }
    throw err;
  }
}

export async function buildWorkflowDraft(
  args: BuildWorkflowArgs,
): Promise<BuildWorkflowResult> {
  const maxAttempts = args.maxAttempts ?? 3;
  const messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }> = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        args.baseDefinition
          ? `Modify this base workflow to satisfy the instruction. Base:\n${JSON.stringify(args.baseDefinition)}`
          : 'Author a new workflow satisfying the instruction.',
        '',
        `Instruction: ${args.instruction}`,
      ].join('\n'),
    },
  ];

  let costUsd = 0;
  let lastIssues: BuildWorkflowIssue[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Last attempt switches to the fallback model when configured —
    // same "primary retries, fallback closes" contract as the merge
    // resolver.
    const model =
      attempt === maxAttempts && args.fallbackModel
        ? args.fallbackModel
        : args.primaryModel;
    let content: string;
    try {
      const resp = await args.provider.complete({
        model,
        messages,
        temperature: 0.2,
      });
      costUsd += resp.costUsd;
      content = resp.content;
    } catch (err) {
      lastIssues = [
        {
          path: 'provider',
          message: (err as Error).message?.slice(0, 300) ?? String(err),
        },
      ];
      continue;
    }

    let candidate: unknown;
    try {
      candidate = extractJson(content);
    } catch (err) {
      lastIssues = [{ path: 'output', message: (err as Error).message }];
      messages.push({ role: 'assistant', content: content.slice(0, 4_000) });
      messages.push({
        role: 'user',
        content:
          'That output was not parseable JSON. Reply with the FULL corrected JSON object only.',
      });
      continue;
    }

    const verdict = validateDraft(candidate);
    if (verdict.ok) {
      return {
        ok: true,
        definition: verdict.definition,
        runnable: verdict.runnable,
        runnableReason: verdict.runnableReason,
        costUsd,
        attempts: attempt,
        modelUsed: model,
      };
    }
    lastIssues = verdict.issues;
    messages.push({ role: 'assistant', content: JSON.stringify(candidate) });
    messages.push({
      role: 'user',
      content: `Validation failed:\n${verdict.issues
        .map((i) => `- ${i.path}: ${i.message}`)
        .join('\n')}\nReply with the FULL corrected JSON object only.`,
    });
  }

  return {
    ok: false,
    error: 'workflow_draft_failed',
    message: `Could not produce a valid WorkflowDefinition in ${maxAttempts} attempts.`,
    issues: lastIssues,
    costUsd,
    attempts: maxAttempts,
  };
}

// Re-exported for the drafting engine's tests — asserting the briefing
// mentions every active stage kind keeps the prompt from drifting when
// the schema grows.
export const __buildWorkflowInternals = { SYSTEM_PROMPT, extractJson };
