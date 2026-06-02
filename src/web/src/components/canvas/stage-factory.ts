import type { CanvasStage } from './types';

/**
 * Pure factories + predicates the editor uses to add / delete / rename
 * stages. Pulled out of the editor so the behaviour is testable in
 * isolation and the WorkflowCanvasInner component stays focused on the
 * React/xyflow wiring.
 *
 *  - `newStageId(kind, usedIds)` picks the next free `<base><n>` id.
 *  - `createDefaultStage(kind, opts)` returns the initial `CanvasStage`
 *    payload the "+ X" toolbar buttons stamp into the canvas.
 *  - `readBranches(stage)` reads branch labels from routing stages (and
 *    returns null for non-routing kinds so the rename-sync path bails
 *    cheaply).
 *  - `isStagePinned(stage)` is the delete guard for non-removable
 *    nodes (Process Start mo_stage + the two terminal sinks).
 */

const ID_BASE: Record<CanvasStage['kind'], string> = {
  cli_agent: 'stage',
  mcp_tool_call: 'tool',
  human_gate: 'gate',
  mo_router: 'mo',
  eject: 'eject',
  mo_stage: 'mo',
  reject_sink: 'reject',
  complete_sink: 'complete',
  branch: 'branch',
};

/** Return the next free `<base><n>` stage id given the set of ids already
 *  on the canvas. `nodeCount` is the suggested starting index — we add 1
 *  and walk upward until we hit a free slot, so a fresh canvas gets
 *  `stage1` rather than `stage0`. */
export function newStageId(
  kind: CanvasStage['kind'],
  usedIds: ReadonlySet<string>,
  nodeCount: number,
): string {
  const base = ID_BASE[kind] ?? 'stage';
  for (let i = nodeCount + 1; ; i++) {
    const candidate = `${base}${i}`;
    if (!usedIds.has(candidate)) return candidate;
  }
}

export interface CreateStageOpts {
  id: string;
  /** Whether the canvas already has a Process Start mo_stage. Drives
   *  the auto-isStart behaviour: when the user adds their first mo_stage
   *  on a fresh canvas it becomes the Process Start so the schema's
   *  "exactly one mo_stage{isStart:true}" invariant is satisfiable
   *  without a hidden affordance. */
  hasExistingStart?: boolean;
}

export function createDefaultStage(
  kind: CanvasStage['kind'],
  opts: CreateStageOpts,
): CanvasStage {
  const { id, hasExistingStart = false } = opts;
  if (kind === 'cli_agent') {
    return {
      id,
      kind: 'cli_agent',
      agent: 'claude',
      promptTemplate:
        'Working on "{{ticket.title}}" ({{ticket.id}}).\n\n{{ticket.body}}',
      maxBudgetUsd: 1,
      maxAttempts: 1,
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    };
  }
  if (kind === 'mcp_tool_call') {
    return {
      id,
      kind: 'mcp_tool_call',
      toolName: 'mo_ask',
      argsTemplate: { question: 'Summarise "{{ticket.title}}"' },
      maxAttempts: 1,
    };
  }
  if (kind === 'human_gate') {
    // Single-in / single-out text dialog. Wire its outbound edge BACK
    // to the Mo decision stage that asked the question — Mo re-evaluates
    // with the user's reply as fresh context.
    return {
      id,
      kind: 'human_gate',
      prompt:
        'Mo paused this run to ask you a question. Reply in chat with whatever Mo needs to know — once you submit, Mo reads your reply and picks the next step.',
    };
  }
  if (kind === 'mo_router') {
    return {
      id,
      kind: 'mo_router',
      prompt:
        'Look at the ticket title + body. Decide which branch fits best.',
      branches: ['bug', 'feature', 'docs'],
    };
  }
  if (kind === 'eject') {
    return { id, kind: 'eject', reason: 'Ejected by workflow' };
  }
  if (kind === 'mo_stage') {
    // v2 Mo decision stage. Two-branch default ('approve' / 'reject')
    // satisfies branches.min(2) at save time. When the canvas has no
    // Process Start yet, this new stage takes that role automatically
    // (the side panel doesn't expose an isStart toggle).
    const willBeStart = !hasExistingStart;
    return {
      id,
      kind: 'mo_stage',
      instruction: willBeStart
        ? 'Read the ticket title + body. Decide "accept" when the ticket has enough detail for the workflow to act on, or "reject" when it should bounce back to backlog.'
        : 'Look at the ticket title + body. Decide which branch fits best.',
      branches: ['approve', 'reject'],
      postComment: true,
      isStart: willBeStart,
      allowedTools: null,
    };
  }
  if (kind === 'reject_sink') {
    return { id, kind: 'reject_sink', commentTemplate: '' };
  }
  if (kind === 'complete_sink') {
    return { id, kind: 'complete_sink', commentTemplate: '' };
  }
  // branch — DAG runtime is L4. Visual support only.
  return {
    id,
    kind: 'branch',
    combinator: 'all',
    conditions: [
      { field: 'stages.fix.output.verdict', op: 'eq', value: 'approve' },
    ],
  };
}

/** Read the multi-out routing stage's branch labels (mo_stage or
 *  mo_router); returns null when the stage isn't a routing node so the
 *  branch-rename-sync path can be skipped cheaply. */
export function readBranches(stage: CanvasStage | null): string[] | null {
  if (!stage) return null;
  if (stage.kind === 'mo_stage' || stage.kind === 'mo_router') {
    return Array.isArray((stage as { branches?: unknown }).branches)
      ? (stage as { branches: string[] }).branches.slice()
      : null;
  }
  return null;
}

/** Compute whether the stage can be deleted. Mirrors the v2 spec
 *  "Process Start Step (can't be removed)" and "Reject / Complete sink
 *  — always present, can't remove" invariants. */
export function isStagePinned(stage: CanvasStage | null): boolean {
  if (!stage) return false;
  if (stage.kind === 'mo_stage' && stage.isStart) return true;
  if (stage.kind === 'reject_sink' || stage.kind === 'complete_sink') {
    return true;
  }
  return false;
}
