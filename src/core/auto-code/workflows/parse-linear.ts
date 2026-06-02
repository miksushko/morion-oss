import { z } from 'zod';

import { WorkflowDefinitionSchema, type WorkflowDefinition } from './types/index.js';

/**
 * Auto-code Workflow Builder L2.T2 — linear-pipeline parser.
 *
 * `WorkflowDefinitionSchema` is the wire format used both by L2 (linear
 * only) and L4 (DAG editor). On the L2 runner path we additionally
 * enforce:
 *
 *   1. Every stage is `cli_agent` OR `mcp_tool_call`. `human_gate`,
 *      `branch`, `mo_router`, `eject`, plus the v2 editor-model kinds
 *      `mo_stage` / `reject_sink` / `complete_sink` (spec
 *      01KRAQWPXR5AYTFVF6J12TYHJ1) are reserved for L3 / L4 — the
 *      visual editor accepts them so DAG flows can be drafted but
 *      the linear runtime rejects them until the DAG runner ships.
 *      `mcp_tool_call` was enabled in Этап 4 (2026-05-10).
 *   2. Edges either empty (the runner walks `stages[]` in array order)
 *      OR form a single forward chain matching the array order
 *      (stages[0]→stages[1]→...→stages[N-1]) with `on='success'`. Any
 *      other edge configuration implies a DAG and is rejected.
 *
 * The L4 editor will eventually call `WorkflowDefinitionSchema.parse`
 * directly without these extra constraints.
 */

export class LinearWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinearWorkflowError';
  }
}

/**
 * Parse + validate a workflow definition under L2 linear-only constraints.
 * Throws `z.ZodError` on schema-shape failures and `LinearWorkflowError`
 * on linear-only violations.
 */
export function parseLinearWorkflow(input: unknown): WorkflowDefinition {
  const def = WorkflowDefinitionSchema.parse(input);

  // (1) cli_agent + mcp_tool_call stages only. `human_gate` (L3) and
  //     `branch` (L4) stay reserved for the DAG editor.
  for (const [idx, stage] of def.stages.entries()) {
    if (stage.kind !== 'cli_agent' && stage.kind !== 'mcp_tool_call') {
      throw new LinearWorkflowError(
        `stage[${idx}] (id="${stage.id}") has kind="${stage.kind}" which is reserved for L3/L4 — L2 runner accepts cli_agent + mcp_tool_call stages only`,
      );
    }
  }

  // (1b) cli_agent Agent Status fields (Phase 3) are now plumbed
  //      through to harness.spawn via SpawnOptions.provider / model /
  //      level + an `agentInstruction` prefix applied to the rendered
  //      prompt. The linear runner accepts these fields verbatim;
  //      adapters that don't honour a given knob ignore it gracefully.
  //      Phase 4 sibling work landed the plumbing — no reject here.

  // (2) edges must be empty OR a single forward chain matching array order.
  if (def.edges.length === 0) return def;

  const expectedEdgeCount = def.stages.length - 1;
  if (def.edges.length !== expectedEdgeCount) {
    throw new LinearWorkflowError(
      `linear definitions need exactly N-1 edges in stage-array order (got ${def.edges.length}, expected ${expectedEdgeCount} for ${def.stages.length} stages) — DAG configurations are L4`,
    );
  }
  for (let i = 0; i < expectedEdgeCount; i++) {
    const edge = def.edges[i];
    const fromExpected = def.stages[i].id;
    const toExpected = def.stages[i + 1].id;
    if (edge.from !== fromExpected || edge.to !== toExpected) {
      throw new LinearWorkflowError(
        `edge[${i}] expected ${fromExpected}→${toExpected} (linear array order) got ${edge.from}→${edge.to}`,
      );
    }
    if (edge.on !== 'success') {
      throw new LinearWorkflowError(
        `edge[${i}] (${edge.from}→${edge.to}) has on="${edge.on}" — L2 only supports on="success"`,
      );
    }
  }

  return def;
}

/**
 * Type-narrowing variant: returns the parsed definition annotated with
 * the cli-agent-only stage type. Useful when the runner wants the
 * stronger type without runtime branching.
 */
export type LinearWorkflowDefinition = z.infer<
  typeof WorkflowDefinitionSchema
>;

// --- v2 editor support ------------------------------------------------

const V2_STAGE_KINDS: ReadonlySet<string> = new Set([
  'mo_stage',
  'reject_sink',
  'complete_sink',
  // mo_router + eject are deprecated aliases for mo_stage / reject_sink
  // respectively — kept in this set so existing canvas drafts using the
  // old names also count as "v2 drafts" and get the relaxed save path.
  'mo_router',
  'eject',
  // `human_gate` is the v2 "Human in the loop" stage from the Editor
  // Model spec (Morion note 01KRAQWPXR5AYTFVF6J12TYHJ1). Runtime
  // support is L3 (blocked on `01KR5FBYS9QRM60BMX54DR1XZR` mo_get_context
  // bug + ask_user MCP tool), but the editor surfaces it as a
  // visible stage in v2 templates so the diagram matches the spec.
  // Listed here so templates containing human_gate route through
  // parseDraftWorkflow at save time and fail cleanly at dispatch
  // (parseLinearWorkflow's L3/L4 reserved gate) until L3 ships.
  'human_gate',
  // Note: `branch` (L4) stays OUT — no editor template uses it yet.
  // Move it in once L4 conditional routing surfaces in templates.
]);

/**
 * Returns true when the definition contains any stage kind the L2
 * linear runner can't execute (mo_stage / reject_sink / complete_sink
 * / mo_router / eject / human_gate). Used by `workflows-repository`
 * to pick between `parseLinearWorkflow` (strict — linear runnable)
 * and `parseDraftWorkflow` (v2 — runs through the Phase 4 DAG runner).
 *
 * Agent Status fields on cli_agent (provider / model / level /
 * agentInstruction / fallback overrides) are NOT draft markers
 * anymore — the runner plumbs them through to `harness.spawn` as of
 * Phase 4, so the linear save path accepts them too. Pinned by the
 * "parseLinearWorkflow accepts cli_agent with non-default Agent
 * Status fields" test in workflow-types-v2-invariants.
 */
export function isDraftWorkflowDefinition(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const stages = (input as { stages?: unknown }).stages;
  if (!Array.isArray(stages)) return false;
  for (const s of stages) {
    if (typeof s !== 'object' || s === null) continue;
    const kind = (s as { kind?: unknown }).kind;
    if (typeof kind === 'string' && V2_STAGE_KINDS.has(kind)) return true;
  }
  return false;
}

/**
 * Parse + validate a workflow definition for the v2 editor "draft"
 * save path. Runs the full `WorkflowDefinitionSchema` (which already
 * enforces the v2 invariants via superRefine — exactly one
 * `mo_stage{isStart:true}`, exactly one of each terminal sink, no
 * outbound from sinks, edge.on ↔ branches, etc.) but does NOT enforce
 * the linear-only L2 constraints.
 *
 * Workflows saved through this path are NOT runnable until the Phase 4
 * DAG runner lands — the runner's dispatch path stays on
 * `parseLinearWorkflow` and surfaces a clean
 * `stage[i] (id="...") has kind="mo_stage" which is reserved for L3/L4`
 * error when the user tries to enqueue a ticket against a draft
 * workflow. The editor signals "draft, not yet runnable" so the
 * affordance is honest.
 *
 * Throws `z.ZodError` on schema-shape failures (including the v2
 * invariants). Does NOT throw `LinearWorkflowError` because the
 * linear-only gate is intentionally skipped here.
 */
export function parseDraftWorkflow(input: unknown): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse(input);
}

/** Stage kinds the Phase 4 DAG runner can execute. `human_gate`
 *  (Phase 5) and `branch` (L4 conditional routing) are still
 *  reserved — workflows with them parse but fail at dispatch with a
 *  clean envelope (see runner's DAG dispatch). */
const DAG_RUNNABLE_KINDS: ReadonlySet<string> = new Set([
  'cli_agent',
  'mcp_tool_call',
  'mo_stage',
  // legacy alias still produced by older drafts; routed to mo_stage
  // dispatch (same shape, same branches contract).
  'mo_router',
  'reject_sink',
  // legacy alias for reject_sink. Terminal; the runner treats it as
  // a reject_sink at dispatch.
  'eject',
  'complete_sink',
  // Phase 5 MVP (ticket 01KRFT0742GY480WFJTAW02Z05) — DAG runner now
  // pauses the run + opens an Ask Mo session at human_gate stages.
  // The session-linked resume hook in the chat route flips the run
  // back to `running` when the user replies.
  'human_gate',
]);

/** Returns true when the definition contains any DAG-only stage
 *  kind (mo_stage / reject_sink / complete_sink / mo_router / eject).
 *  Used by the runner to switch between linear dispatch (array-order
 *  walk) and DAG dispatch (edges-driven walk). Pure cli_agent /
 *  mcp_tool_call workflows still run on the linear path even when
 *  v2 Agent Status fields are set — those don't need edge routing. */
export function isDagWorkflowDefinition(def: WorkflowDefinition): boolean {
  for (const s of def.stages) {
    if (
      s.kind === 'mo_stage' ||
      s.kind === 'mo_router' ||
      s.kind === 'reject_sink' ||
      s.kind === 'eject' ||
      s.kind === 'complete_sink' ||
      s.kind === 'human_gate'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Phase 4 entry validator. Accepts BOTH linear and DAG-shape workflows:
 * full schema parse first (so v2 invariants fire), then for linear
 * definitions also enforce the strict array-order edge chain.
 *
 * Throws `z.ZodError` on schema-shape failures and `LinearWorkflowError`
 * on linear-only violations (only when the definition lacks any
 * DAG-only stage kind).
 *
 * Returns the parsed (default-applied) definition. The runner uses
 * `isDagWorkflowDefinition()` on the result to pick a dispatcher.
 */
export function parseRunnableWorkflow(input: unknown): WorkflowDefinition {
  const def = WorkflowDefinitionSchema.parse(input);
  if (isDagWorkflowDefinition(def)) {
    // Defence in depth — make sure every stage kind has a runtime
    // path. `human_gate` and `branch` are still reserved.
    for (const [idx, stage] of def.stages.entries()) {
      if (!DAG_RUNNABLE_KINDS.has(stage.kind)) {
        throw new LinearWorkflowError(
          `stage[${idx}] (id="${stage.id}") has kind="${stage.kind}" which is reserved — Phase 4 DAG runner accepts ${[
            ...DAG_RUNNABLE_KINDS,
          ]
            .map((k) => `"${k}"`)
            .join(' / ')}`,
        );
      }
    }
    return def;
  }
  // Linear path — same array-order edge chain enforcement as
  // parseLinearWorkflow above.
  return parseLinearWorkflow(def);
}
