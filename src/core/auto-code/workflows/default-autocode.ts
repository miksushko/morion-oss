import { parseDraftWorkflow, parseLinearWorkflow } from './parse-linear.js';
import type { CliAgentName, WorkflowDefinition } from './types/index.js';

/**
 * Auto-code Workflow Builder — canonical "Default Autocode" template.
 *
 * v2 shape (Editor Model spec, Morion note 01KRAQWPXR5AYTFVF6J12TYHJ1):
 *
 *   mo_start (Process Start, isStart=true)
 *     ├ accept → fix
 *     └ reject → reject_terminal
 *
 *   fix (cli_agent · claude)
 *     → mo_after_fix
 *
 *   mo_after_fix (Mo)
 *     ├ review → review
 *     ├ ask_human → human_chat  (visual; runtime is L3, blocked on
 *     │                          mo_get_context — drops to reject at
 *     │                          dispatch until then)
 *     └ reject → reject_terminal
 *
 *   review (cli_agent · codex, fallbackAgent=claude)
 *     → mo_after_review
 *
 *   mo_after_review (Mo)
 *     ├ approve → mo_tools
 *     ├ reopen  → fix             (DAG back-edge; Phase 4 runner
 *     │                           enforces reopen cap via Mo memory)
 *     └ reject  → reject_terminal
 *
 *   mo_tools (Mo · Mo Tools — record result via MCP calls)
 *     ├ done          → complete_terminal
 *     └ tools_failed  → reject_terminal
 *
 *   reject_terminal (reject_sink — ticket → backlog + Mo comment)
 *   complete_terminal (complete_sink — ticket → done + Mo comment)
 *
 * This is a v2 DRAFT — the L2 linear runner can't dispatch it. The
 * Phase 4 DAG runner consumes mo_stage decisions + edge routing +
 * sink terminals; until then orchestrator.enqueueTicket returns
 * `{kind:'rejected', reason:'workflow_not_runnable'}` with an
 * actionable message.
 *
 * Parsed via parseDraftWorkflow at module load so any future schema-
 * tightening that breaks this shape fails the build, not the next
 * user drag-to-todo.
 */

interface V2AgentSpec {
  readonly agent: CliAgentName;
  readonly promptTemplate: string;
  readonly maxBudgetUsd?: number;
  readonly maxAttempts?: number;
  readonly allowedTools?: readonly string[];
  readonly fallbackAgent?: CliAgentName;
}

interface BuildV2TemplateOpts {
  readonly name: string;
  readonly description: string;
  /** Optional pre-fix planning stage (feature-planning template). */
  readonly planAgent?: V2AgentSpec;
  /** Optional reviewer for the plan itself. When set, the workflow
   *  inserts a separate `plan_review` cli_agent stage between
   *  `mo_after_plan` and `fix`, with a `mo_after_plan_review` Mo
   *  decision node that can `approve → fix`, `reopen → plan` (back
   *  edge), or `reject → reject_terminal`. Ignored when
   *  `planAgent` is absent (Mo doesn't get a plan to review when no
   *  planner ran). Ticket 01KRWRHFAK7HPQYV8GN72BW2VC. */
  readonly planReviewAgent?: V2AgentSpec;
  /** Mandatory primary agent — writes the diff / does the work. */
  readonly fixAgent: V2AgentSpec;
  /** Optional review stage. When present the workflow includes a
   *  mo_after_review decision node with approve/reopen/reject branches;
   *  when absent the fix-stage advances directly to mo_tools. */
  readonly reviewAgent?: V2AgentSpec;
  /** Mo's Process Start prompt — typically a one-sentence eligibility
   *  rule the user can edit ("is the ticket detailed enough", "does
   *  it have acceptance criteria", etc.). */
  readonly startInstruction: string;
  /** Mo's instruction for the post-fix decision. */
  readonly afterFixInstruction: string;
  /** Mo's instruction for the post-plan-review decision (after the
   *  plan_review agent runs). Ignored when planReviewAgent is absent.
   *  Defaults to a sensible "approve / reopen / reject" instruction. */
  readonly afterPlanReviewInstruction?: string;
  /** Mo's instruction for the post-review decision. Ignored when
   *  reviewAgent is absent. */
  readonly afterReviewInstruction?: string;
  /** Mo's instruction for the Mo Tools record stage. */
  readonly toolsInstruction: string;
  /** MCP tools the mo_tools stage is allowed to call. */
  readonly toolsAllowedTools?: readonly string[];
  /** When true the post-fix Mo decision exposes an `ask_human`
   *  branch routing to a `human_gate` stage; the human's reply
   *  loops back to `mo_after_fix` for re-evaluation. Runtime
   *  support is L3 (blocked on the mo_get_context bug + ask_user
   *  MCP tool) — the editor accepts the stage today so flows
   *  match the spec's "Human In The Loop" node from Morion note
   *  01KRAQWPXR5AYTFVF6J12TYHJ1. */
  readonly withHumanInLoop?: boolean;
  /** Prompt shown to the user in the chat when `human_gate` fires
   *  (used only when `withHumanInLoop=true`). */
  readonly humanPrompt?: string;
}

const DEFAULT_TOOLS_ALLOWED: readonly string[] = [
  'notes_update',
  'notes_add_comment',
  'tasks_move',
];

// Empty by default — Mo's own decision comment (posted by the
// preceding mo_stage via `output.comment`) is the user-facing
// explanation for both reject + complete sinks. A hardcoded sink
// commentTemplate produced a duplicate "Auto-code rejected this
// ticket. Typically: under-specified ticket..." line right after
// Mo's actual reason ("Mo decided: reject. Ticket lacks ..."),
// which was a confusing double-post the user flagged 2026-05-11.
// Users who want a custom closing comment can edit the sink stage
// in the workflow editor; empty means "no extra comment, Mo's
// last word stands".
const DEFAULT_REJECT_COMMENT = '';
const DEFAULT_COMPLETE_COMMENT = '';

/**
 * Builds a v2 workflow definition matching the spec's "Dev Process"
 * shape (Morion note 01KRAQWPXR5AYTFVF6J12TYHJ1). Used by both the
 * canonical Default Autocode and the shipped template registry so
 * every starting point looks like the user's diagram.
 *
 * Stage ids are stable across templates — `mo_start`, `fix`,
 * `mo_after_fix`, `review`, `mo_after_review`, `mo_tools`,
 * `reject_terminal`, `complete_terminal`. A pre-fix `plan` stage
 * appears when planAgent is set, with a `mo_after_plan` decision
 * node between plan and fix.
 */
export function buildAutocodeV2Template(opts: BuildV2TemplateOpts): WorkflowDefinition {
  const hasPlan = !!opts.planAgent;
  const hasPlanReview = !!opts.planReviewAgent && hasPlan;
  const hasReview = !!opts.reviewAgent;

  const cliAgentStage = (
    id: string,
    spec: V2AgentSpec,
  ): Record<string, unknown> => ({
    id,
    kind: 'cli_agent',
    agent: spec.agent,
    promptTemplate: spec.promptTemplate,
    maxBudgetUsd: spec.maxBudgetUsd ?? 2,
    maxAttempts: spec.maxAttempts ?? 3,
    allowedTools: [...(spec.allowedTools ?? [])],
    ...(spec.fallbackAgent ? { fallbackAgent: spec.fallbackAgent } : {}),
  });

  const stages: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];

  // mo_start — Process Start Step (always present).
  stages.push({
    id: 'mo_start',
    kind: 'mo_stage',
    isStart: true,
    instruction: opts.startInstruction,
    branches: ['accept', 'reject'],
    postComment: true,
    allowedTools: [], // pure LLM decision — no tool context needed.
  });

  if (hasPlan) {
    // plan → mo_after_plan → (plan_review → mo_after_plan_review →) fix
    stages.push(cliAgentStage('plan', opts.planAgent!));
    // mo_after_plan: gate the plan itself. When a separate plan_review
    // cli agent is wired, Mo can either hand it off for review or
    // short-circuit to reject. Without plan_review, "implement"
    // routes directly to fix (the legacy single-Mo-decision path).
    const afterPlanBranches = hasPlanReview
      ? ['review_plan', 'reject']
      : ['implement', 'reject'];
    stages.push({
      id: 'mo_after_plan',
      kind: 'mo_stage',
      instruction: hasPlanReview
        ? 'Read the plan stage output. Pick "review_plan" when the plan has enough substance for an independent reviewer to verify (names files, sketches the approach). Pick "reject" if the plan is empty / hand-wavy / says the ticket is impossible.'
        : 'Read the plan stage output. Decide whether the plan is concrete enough to hand off to the implementer. Pick "implement" when the plan names files + sketches code changes; "reject" if the plan is empty / hand-wavy / says the ticket is impossible.',
      branches: afterPlanBranches,
      postComment: true,
      allowedTools: [],
    });
    edges.push({ from: 'mo_start', to: 'plan', on: 'accept' });
    edges.push({ from: 'plan', to: 'mo_after_plan', on: 'success' });
    if (hasPlanReview) {
      // plan_review (cli_agent) → mo_after_plan_review (Mo decides
      // approve / reopen→plan / reject). The reopen edge back to
      // `plan` is the planning analogue of the post-code-review
      // `reopen → fix` back edge — same shape so the runner's cap
      // logic applies uniformly. Ticket 01KRWRHFAK7HPQYV8GN72BW2VC.
      stages.push(cliAgentStage('plan_review', opts.planReviewAgent!));
      stages.push({
        id: 'mo_after_plan_review',
        kind: 'mo_stage',
        instruction:
          opts.afterPlanReviewInstruction ??
          'Read the plan-reviewer summary. Pick "approve" when the reviewer signs off and the plan is ready to implement. Pick "reopen" when the reviewer cites specific gaps that another planning pass could close (loops back to the planner). Pick "reject" when the reviewer escalates / the plan can\'t be salvaged.',
        branches: ['approve', 'reopen', 'reject'],
        postComment: true,
        allowedTools: [],
      });
      edges.push({ from: 'mo_after_plan', to: 'plan_review', on: 'review_plan' });
      edges.push({ from: 'plan_review', to: 'mo_after_plan_review', on: 'success' });
      edges.push({ from: 'mo_after_plan_review', to: 'fix', on: 'approve' });
      edges.push({ from: 'mo_after_plan_review', to: 'plan', on: 'reopen' });
      edges.push({ from: 'mo_after_plan_review', to: 'reject_terminal', on: 'reject' });
    } else {
      edges.push({ from: 'mo_after_plan', to: 'fix', on: 'implement' });
    }
    edges.push({ from: 'mo_after_plan', to: 'reject_terminal', on: 'reject' });
  } else {
    edges.push({ from: 'mo_start', to: 'fix', on: 'accept' });
  }
  edges.push({ from: 'mo_start', to: 'reject_terminal', on: 'reject' });

  // fix — primary work agent.
  stages.push(cliAgentStage('fix', opts.fixAgent));
  edges.push({ from: 'fix', to: 'mo_after_fix', on: 'success' });

  // mo_after_fix — decide what's next. When withHumanInLoop is set
  // the post-fix Mo gets a third "ask_human" branch routing to a
  // human_gate stage (Editor Model v2 spec, Morion note
  // 01KRAQWPXR5AYTFVF6J12TYHJ1 — "Human In The Loop [Chat]"). The
  // human's reply loops back to mo_after_fix for re-evaluation; the
  // L3 runtime that drives this lands later (blocked on the
  // mo_get_context bug + ask_user MCP tool).
  const hasHumanInLoop = opts.withHumanInLoop === true;
  const advanceBranch = hasReview ? 'review' : 'finish';
  const afterFixBranches = hasHumanInLoop
    ? [advanceBranch, 'ask_human', 'reject']
    : [advanceBranch, 'reject'];
  stages.push({
    id: 'mo_after_fix',
    kind: 'mo_stage',
    instruction: opts.afterFixInstruction,
    branches: afterFixBranches,
    postComment: true,
    allowedTools: [],
  });
  if (hasReview) {
    edges.push({ from: 'mo_after_fix', to: 'review', on: 'review' });
  } else {
    edges.push({ from: 'mo_after_fix', to: 'mo_tools', on: 'finish' });
  }
  edges.push({ from: 'mo_after_fix', to: 'reject_terminal', on: 'reject' });
  if (hasHumanInLoop) {
    // Human In The Loop is a side-attached text dialog (Editor Model
    // v2 spec refined 2026-05-11). Single in / single out: the user
    // writes a free-text reply, the reply is appended to ticket
    // context, control returns to the SAME Mo decision stage which
    // re-evaluates. The stage itself doesn't branch — Mo decides on
    // its next turn (continue / reject / etc) based on the reply.
    //
    // Phase 6 V2 (2026-05-13): the literal text posted to the
    // chat is composed by Mo at runtime via MoMessengerDispatcher
    // (commit B of this batch), reading the full ticket context.
    // The stage's `guidance` field is the workflow author's
    // hint to Mo about what to ask about. The legacy `prompt:
    // string` field is dropped — static placeholders were bypassing
    // Mo's role as the conversational lead.
    stages.push({
      id: 'human_chat',
      kind: 'human_gate',
      ...(opts.humanPrompt ? { guidance: opts.humanPrompt } : {}),
    });
    edges.push({ from: 'mo_after_fix', to: 'human_chat', on: 'ask_human' });
    edges.push({ from: 'human_chat', to: 'mo_after_fix', on: 'reply' });
  }

  if (hasReview) {
    stages.push(cliAgentStage('review', opts.reviewAgent!));
    edges.push({ from: 'review', to: 'mo_after_review', on: 'success' });

    stages.push({
      id: 'mo_after_review',
      kind: 'mo_stage',
      instruction:
        opts.afterReviewInstruction ??
        'Read the reviewer summary. Pick "approve" when the reviewer signs off, "reopen" when the reviewer asks for another pass, "reject" when the reviewer escalates or the work cannot continue.',
      branches: ['approve', 'reopen', 'reject'],
      postComment: true,
      allowedTools: [],
    });
    edges.push({ from: 'mo_after_review', to: 'mo_tools', on: 'approve' });
    edges.push({ from: 'mo_after_review', to: 'fix', on: 'reopen' });
    edges.push({ from: 'mo_after_review', to: 'reject_terminal', on: 'reject' });
  }

  // mo_tools — record result via MCP.
  stages.push({
    id: 'mo_tools',
    kind: 'mo_stage',
    instruction: opts.toolsInstruction,
    branches: ['done', 'tools_failed'],
    postComment: true,
    allowedTools: [...(opts.toolsAllowedTools ?? DEFAULT_TOOLS_ALLOWED)],
  });
  edges.push({ from: 'mo_tools', to: 'complete_terminal', on: 'done' });
  edges.push({ from: 'mo_tools', to: 'reject_terminal', on: 'tools_failed' });

  // Terminal sinks — always present, can't be removed.
  stages.push({
    id: 'reject_terminal',
    kind: 'reject_sink',
    commentTemplate: DEFAULT_REJECT_COMMENT,
  });
  stages.push({
    id: 'complete_terminal',
    kind: 'complete_sink',
    commentTemplate: DEFAULT_COMPLETE_COMMENT,
  });

  return parseDraftWorkflow({
    schemaVersion: 1,
    name: opts.name,
    description: opts.description,
    stages,
    edges,
  });
}

const DEFAULT_FIX_PROMPT = [
  'You are working on Morion ticket "{{ticket.title}}" ({{ticket.id}}).',
  '',
  'Acceptance criteria + recent context follow. Write a diff that fully',
  'satisfies the criteria. Use the available tools to read the repo,',
  'understand the surrounding code, and make focused edits. Do not',
  'introduce unrelated refactors.',
  '',
  // Phase 6 V2 (Morion ticket 01KRG02E2SV2F9F3PZ6TPDDCNA) —
  // conversational handoff via Mo as the project lead. When the
  // agent hits a real ambiguity, it should END ITS STAGE with the
  // question prominently in its output text. Mo reads the output on
  // the next mo_stage, decides whether to answer from context or
  // open a chat with the user, and routes the workflow accordingly.
  // No blocking tool — agent just outputs and exits.
  'If you hit a real ambiguity that blocks a quality fix — the kind of',
  'question you would ask a human teammate ("should X be stacked or',
  'columnar?", "keep the legacy fallback?") — end your stage with the',
  'question clearly at the top of your output, prefixed by "QUESTION:".',
  'Mo (the project lead) will read your output, either answer from',
  'context or ask the user, and re-invoke you with the answer. Reserve',
  'this for real ambiguity — trivial questions waste cycles.',
  '',
  '{{ticket.body}}',
  '',
  '--- Recent comments ---',
  '{{ticket.recentComments}}',
  '',
  '{{reopen.reason}}',
].join('\n');

const DEFAULT_REVIEW_PROMPT = [
  'You are reviewing the work done by the previous "fix" stage of',
  'ticket "{{ticket.title}}" ({{ticket.id}}).',
  '',
  'Fix-stage summary:',
  '```',
  '{{stages.fix.output.summary}}',
  '```',
  '',
  'Read the actual files in this worktree to verify the diff. Then',
  'write a short reviewer summary covering:',
  '  - whether the work satisfies the acceptance criteria',
  '  - any issues that need another pass',
  '  - anything blocked / ambiguous that needs human input',
  '',
  'Mo will read your summary and decide whether to approve / reopen /',
  'reject the run on the next stage.',
].join('\n');

export const DEFAULT_AUTOCODE_DEFINITION: WorkflowDefinition = buildAutocodeV2Template({
  name: 'Code + code review',
  description:
    'Two cli agents with Mo between them and human-in-the-loop where the implementer surfaces ambiguity: Mo gate → Claude writes the diff → Mo decision → Codex review (claude-fallback) → Mo decision → Mo Tools records the result → Complete. The reviewer can reopen the implementer; every Mo decision has a reject path.',
  // Permissive default — accept-by-default per Editor Model v2 spec
  // example ("отправляй в код любой тикет, кроме пустых"). User
  // tightens this either by editing the stage instruction in the
  // workflow editor OR by setting a folder-level intake instruction
  // (`auto_code.intake_instruction.<folderId>` in workspace settings,
  // surfaced in the folder's Auto-Code settings panel) — the resolver
  // overrides this default at dispatch time when the folder setting
  // is non-empty.
  startInstruction:
    'Read the ticket. Decide "accept" for any ticket that has SOME content to work with — a title plus a body, comments, or any context an autonomous coding agent could act on. Decide "reject" ONLY when the ticket is literally empty. Err on the side of "accept" — the user explicitly dragged this ticket into auto-code and probably wants it tried.',
  fixAgent: {
    agent: 'claude',
    promptTemplate: DEFAULT_FIX_PROMPT,
    maxBudgetUsd: 2,
    maxAttempts: 3,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
  },
  afterFixInstruction:
    'Read the fix-stage summary. Pick "review" when the diff is non-trivial and worth a second-opinion review pass. Pick "ask_human" when the fix raised a concrete question that needs the user to answer before continuing. Pick "reject" when the fix stage failed / hit its budget / produced no diff.',
  withHumanInLoop: true,
  humanPrompt:
    "The agent paused to ask you a question about ticket {{ticket.title}}. Read the fix-stage summary above, reply in chat, and pick \"continue\" to resume the workflow or \"abort\" to eject the ticket from auto-code.",
  reviewAgent: {
    agent: 'codex',
    promptTemplate: DEFAULT_REVIEW_PROMPT,
    maxBudgetUsd: 1,
    maxAttempts: 3,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    fallbackAgent: 'claude',
  },
  toolsInstruction:
    'Record the result of this run: update the ticket status via tasks_move, post a closing comment via notes_add_comment summarising what the agents shipped, and update the ticket body via notes_update if needed. Pick "done" when the MCP calls succeed; pick "tools_failed" if the recording step itself hits an error that needs human triage.',
  toolsAllowedTools: ['notes_update', 'notes_add_comment', 'tasks_move'],
});

/** Sentinel used by `workflow_runs.workflow_id` consumers to detect
 *  the hardcoded definition path. NULL in DB, this constant in code
 *  for future grep-ability. */
export const DEFAULT_AUTOCODE_SENTINEL = null;

/**
 * Pre-v2 linear shape preserved for bridge usage until the Phase 4 DAG
 * runner ships:
 *
 *   - WorkflowOrchestrator's default `resolveDefinitionFn` (when no
 *     per-folder workflow_template setting is present) uses this so
 *     unconfigured auto-code keeps working as the old MVP pipeline
 *     while the v2 templates serve as visual previews of the upcoming
 *     model.
 *   - resolveWorkflowDefinition() in templates.ts falls back to this
 *     for unknown / missing template ids.
 *   - Tests that exercise the L2 linear runner happy path use this
 *     explicitly via `resolveDefinition: () => LEGACY_LINEAR_AUTOCODE_DEFINITION`
 *     on the orchestrator's overrides.
 *
 * Once Phase 4 lands and the DAG runner can dispatch DEFAULT_AUTOCODE_DEFINITION,
 * this const + every callsite goes away.
 */
export const LEGACY_LINEAR_AUTOCODE_DEFINITION: WorkflowDefinition = parseLinearWorkflow({
  schemaVersion: 1,
  name: 'Default Autocode (legacy linear)',
  description:
    'Pre-v2 linear pipeline kept alive until the Phase 4 DAG runner ships. Claude writes the diff; codex reviews with claude-fallback on Ink-crash.',
  stages: [
    {
      id: 'fix',
      kind: 'cli_agent',
      agent: 'claude',
      promptTemplate: DEFAULT_FIX_PROMPT,
      maxBudgetUsd: 2,
      maxAttempts: 3,
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    },
    {
      id: 'review',
      kind: 'cli_agent',
      agent: 'codex',
      promptTemplate: [
        'You are reviewing the work done by the previous "fix" stage of',
        'ticket "{{ticket.title}}" ({{ticket.id}}).',
        '',
        'Fix-stage summary:',
        '```',
        '{{stages.fix.output.summary}}',
        '```',
        '',
        'Read the actual files in this worktree to verify the diff. Then',
        'decide one of:',
        '  - "approve"   — work fully satisfies the acceptance criteria',
        '  - "reopen"    — work is on the right track but needs another pass',
        '  - "escalate"  — the ticket is ambiguous / blocked / needs human input',
        '',
        'Respond with EXACTLY ONE JSON object on the LAST line:',
        '```json',
        '{"verdict": "approve" | "reopen" | "escalate", "reason": "<short>"}',
        '```',
      ].join('\n'),
      maxBudgetUsd: 1,
      maxAttempts: 3,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      fallbackAgent: 'claude',
      verdictPolicy: {
        onReopen: { reopenStageId: 'fix', maxAttempts: 3 },
        onEscalate: 'fail-run',
      },
    },
  ],
  edges: [{ from: 'fix', to: 'review', on: 'success' }],
});
