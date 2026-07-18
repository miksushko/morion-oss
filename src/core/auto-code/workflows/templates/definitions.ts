/**
 * Shipped v2 workflow definitions — one constant per template, NOT
 * counting the canonical "code + code review" template which lives
 * in `../default-autocode.ts` as `DEFAULT_AUTOCODE_DEFINITION`.
 *
 * Ticket 01KRWRHFAK7HPQYV8GN72BW2VC — the registry was trimmed from
 * 7 near-duplicate templates to 3 base shapes. Users author bespoke
 * flows (bug-fix, pi-fix, docs-only, spike, etc.) through the editor
 * once they outgrow the defaults.
 *
 * Each definition is built via `buildAutocodeV2Template` (see
 * `../default-autocode.ts`) which parses through `parseDraftWorkflow`
 * so v2 superRefine invariants fire at module load.
 */

import {
  buildAutocodeV2Template,
  DEFAULT_FIX_PROMPT,
  DEFAULT_REVIEW_PROMPT,
} from '../default-autocode.js';
import type { WorkflowDefinition } from '../types/index.js';
import {
  PERMISSIVE_START_INSTRUCTION,
  PLAN_PROMPT,
  PLAN_REVIEW_PROMPT,
  IMPLEMENT_PROMPT,
  FEATURE_REVIEW_PROMPT,
  DOCS_PROMPT,
  QA_PROMPT,
} from './prompts.js';

/**
 * Process #1 — full pipeline. Four cli agents with Mo between every
 * pair and human-in-the-loop after the fix stage.
 *
 *   plan (claude) → mo_after_plan
 *     → review_plan → plan_review (codex, claude-fallback)
 *         → mo_after_plan_review
 *             → approve → fix
 *             → reopen  → plan
 *             → reject  → reject_terminal
 *     → reject → reject_terminal
 *   fix (claude) → mo_after_fix
 *     → review     → review (codex, claude-fallback)
 *         → mo_after_review
 *             → approve → mo_tools → complete_terminal
 *             → reopen  → fix
 *             → reject  → reject_terminal
 *     → ask_human  → human_chat → mo_after_fix
 *     → reject     → reject_terminal
 */
export const FULL_PIPELINE_DEFINITION: WorkflowDefinition = buildAutocodeV2Template({
  name: 'Plan + plan review + code + code review',
  description:
    'Four cli agents (plan → plan review → code → code review) with Mo gating every handoff and a human-in-the-loop after the fix stage. The plan reviewer can reopen the planner; the code reviewer can reopen the implementer. Use this when the spec is large enough that "just write code" leaves real decisions unmade.',
  startInstruction: PERMISSIVE_START_INSTRUCTION,
  planAgent: {
    agent: 'claude',
    promptTemplate: PLAN_PROMPT,
    maxBudgetUsd: 1,
    maxAttempts: 3,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
  },
  planReviewAgent: {
    agent: 'codex',
    promptTemplate: PLAN_REVIEW_PROMPT,
    maxBudgetUsd: 1,
    maxAttempts: 3,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    fallbackAgent: 'claude',
  },
  fixAgent: {
    agent: 'claude',
    promptTemplate: IMPLEMENT_PROMPT,
    maxBudgetUsd: 2.5,
    maxAttempts: 3,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
  },
  afterFixInstruction:
    'Read the implementation summary. Pick "review" for a second-opinion validation against the plan. Pick "ask_human" when the implementer raised a product / scope question that needs the user to clarify before continuing. Pick "reject" when implementation failed or scope drifted away from the plan.',
  withHumanInLoop: true,
  reviewAgent: {
    agent: 'codex',
    promptTemplate: FEATURE_REVIEW_PROMPT,
    maxBudgetUsd: 1,
    maxAttempts: 3,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    fallbackAgent: 'claude',
  },
  afterReviewInstruction:
    'Read the reviewer summary. Pick "approve" when the implementation matches the plan and the reviewer signs off. Pick "reopen" when the reviewer cites specific gaps another pass could close. Pick "reject" when the plan itself does not fit the ticket / needs human triage.',
  toolsInstruction:
    'Record the result: update the ticket via notes_update / tasks_move, post a closing comment via notes_add_comment summarising the shipped feature. Pick "done" on MCP success; "tools_failed" on errors.',
});

/** Shared fix/review agent specs for the docs / docs+qa flows —
 *  identical to default-v2's stages so the flows differ ONLY by the
 *  extra post-review stages (composition, not agent permutation). */
const SHARED_FIX_AGENT = {
  agent: 'claude',
  promptTemplate: DEFAULT_FIX_PROMPT,
  maxBudgetUsd: 2,
  maxAttempts: 3,
  allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
} as const;

const SHARED_REVIEW_AGENT = {
  agent: 'codex',
  promptTemplate: DEFAULT_REVIEW_PROMPT,
  maxBudgetUsd: 1,
  maxAttempts: 3,
  allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
  fallbackAgent: 'claude',
} as const;

const SHARED_DOCS_AGENT = {
  agent: 'claude',
  promptTemplate: DOCS_PROMPT,
  maxBudgetUsd: 1,
  maxAttempts: 3,
  allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
} as const;

const SHARED_AFTER_FIX_INSTRUCTION =
  'Read the fix-stage summary. Pick "review" when the diff is non-trivial and worth a second-opinion review pass. Pick "ask_human" when the fix raised a concrete question that needs the user to answer before continuing. Pick "reject" when the fix stage failed / hit its budget / produced no diff.';

const SHARED_TOOLS_INSTRUCTION =
  'Record the result: update the ticket via notes_update / tasks_move, post a closing comment via notes_add_comment summarising what the agents shipped. Pick "done" on MCP success; "tools_failed" on errors.';

/**
 * Mo Workflows flow #3 — code + review + docs. After the reviewer
 * approves, a third agent brings the documentation in line with the
 * shipped change (README / docs/ / changelog / JSDoc). Mo gates the
 * docs output with an advance/reopen/reject decision.
 */
export const FIX_REVIEW_DOCS_DEFINITION: WorkflowDefinition = buildAutocodeV2Template({
  name: 'Code + review + docs',
  description:
    'Three cli agents: Claude writes the diff, Codex reviews it (claude-fallback, can reopen the implementer), then a docs agent updates README / docs / changelogs to match what shipped. Human-in-the-loop after fix. Use when the project keeps user-facing docs that must not drift.',
  startInstruction: PERMISSIVE_START_INSTRUCTION,
  fixAgent: SHARED_FIX_AGENT,
  afterFixInstruction: SHARED_AFTER_FIX_INSTRUCTION,
  withHumanInLoop: true,
  reviewAgent: SHARED_REVIEW_AGENT,
  docsAgent: SHARED_DOCS_AGENT,
  toolsInstruction: SHARED_TOOLS_INSTRUCTION,
});

/**
 * Mo Workflows flow #4 — code + review + docs + QA. Extends the docs
 * flow with a fourth agent writing functional tests (playwright specs
 * when the repo has an e2e setup, otherwise a manual checklist)
 * validating the change through the UI.
 */
export const FIX_REVIEW_DOCS_QA_DEFINITION: WorkflowDefinition = buildAutocodeV2Template({
  name: 'Code + review + docs + QA',
  description:
    'Four cli agents: Claude writes the diff, Codex reviews it (claude-fallback), a docs agent updates the documentation, then a QA agent writes functional tests — executable playwright specs when the repo has an e2e setup, otherwise a manual test checklist. Human-in-the-loop after fix. The full assembly line for user-visible features.',
  startInstruction: PERMISSIVE_START_INSTRUCTION,
  fixAgent: SHARED_FIX_AGENT,
  afterFixInstruction: SHARED_AFTER_FIX_INSTRUCTION,
  withHumanInLoop: true,
  reviewAgent: SHARED_REVIEW_AGENT,
  docsAgent: SHARED_DOCS_AGENT,
  qaAgent: {
    agent: 'claude',
    promptTemplate: QA_PROMPT,
    maxBudgetUsd: 1.5,
    maxAttempts: 3,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
  },
  toolsInstruction: SHARED_TOOLS_INSTRUCTION,
});

/**
 * Process #3 — single-agent. Claude writes the diff, Mo posts the
 * closing comment, human-in-the-loop is available so the agent can
 * surface ambiguity. No reviewer — use only when you trust the
 * upstream spec.
 */
export const CODE_ONLY_DEFINITION: WorkflowDefinition = buildAutocodeV2Template({
  name: 'Code only',
  description:
    'Single cli agent with Mo only at the start + end and human-in-the-loop where the agent surfaces a question. No reviewer pass. Best for trivial tickets or when you trust the upstream spec / will review the diff manually.',
  startInstruction: PERMISSIVE_START_INSTRUCTION,
  fixAgent: {
    agent: 'claude',
    promptTemplate: [
      'You are working on Morion ticket "{{ticket.title}}" ({{ticket.id}}).',
      '',
      'Acceptance criteria + recent context follow. Write a diff that fully',
      'satisfies the criteria. Use the available tools to read the repo,',
      'understand the surrounding code, and make focused edits. Do not',
      'introduce unrelated refactors. No reviewer step follows — make the',
      'change tight enough to ship as-is.',
      '',
      'If you hit a real ambiguity that blocks a quality fix — the kind of',
      'question you would ask a human teammate — end your stage with the',
      'question clearly at the top of your output, prefixed by "QUESTION:".',
      'Mo will read your output and either answer from context or ask the',
      'user, then re-invoke you with the answer.',
      '',
      '{{ticket.body}}',
      '',
      '--- Recent comments ---',
      '{{ticket.recentComments}}',
      '',
      '--- Previous auto-code runs of this ticket ---',
      '{{ticket.priorRuns}}',
      '',
      '{{reopen.reason}}',
    ].join('\n'),
    maxBudgetUsd: 2,
    maxAttempts: 1,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
  },
  afterFixInstruction:
    'Read the fix summary. Pick "finish" when the agent produced a diff. Pick "ask_human" when the agent surfaced a real question that needs user input. Pick "reject" when it failed / produced nothing / signalled the work is out of scope.',
  withHumanInLoop: true,
  toolsInstruction:
    'Record the result: update the ticket via notes_update / tasks_move, post a closing comment via notes_add_comment with the diff summary. Pick "done" on MCP success; "tools_failed" on errors.',
});
