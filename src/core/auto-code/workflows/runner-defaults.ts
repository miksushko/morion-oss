/**
 * Module-level constants + default dependency implementations for
 * `WorkflowRunner`. Extracted out of `runner.ts` so per-stage executor
 * modules can import the default seam without dragging the full class.
 *
 * `runner.ts` re-exports every name here for back-compat.
 *
 * Stage 2 of the runner.ts decomposition (ticket
 * 01KRJYYZ3YE57V1PM06ACBDS0T).
 */

import type {
  BudgetGuard,
  HumanGateHandler,
  McpToolDispatcher,
} from './runner-types.js';

/** Lastvalue prefix on a failed run's `lastError` when the failure
 *  came from a `reject_sink` stage (i.e. a deliberate Mo decision to
 *  bounce the ticket, not an infrastructure error). Orchestrator hooks
 *  branch on this prefix to skip the auto-code-paused tag + surface
 *  the sink's rendered comment to the user. */
export const REJECTED_BY_WORKFLOW_PREFIX = 'rejected_by_workflow:';

/** Default implementation — every check passes. The real guard
 *  (workspace-wide auto-code monthly cap) lands in L2.T8 alongside
 *  the `mo_spend_ledger` fix. */
export const PASS_THROUGH_BUDGET_GUARD: BudgetGuard = {
  check: () => ({ allow: true }),
};

/** Default `humanGateHandler` — fails loudly so a runner wired
 *  without the production Ask-Mo handler doesn't silently swallow
 *  human_gate stages. */
export const DEFAULT_HUMAN_GATE_HANDLER: HumanGateHandler = async () => ({
  ok: false,
  reason:
    'human_gate_handler_not_wired: no humanGateHandler injected on this WorkflowRunner. Production factory wires the real Ask Mo session + comment handler.',
});

/** Default `mcpToolDispatcher` — fails every call with a clear
 *  error instead of crashing. Production factory wires the real
 *  impl; tests inject custom stubs. */
export const DEFAULT_MCP_TOOL_DISPATCHER: McpToolDispatcher = async () => ({
  ok: false,
  error: 'mcp_tool_dispatcher_not_wired',
  message:
    'No MCP tool dispatcher injected on this WorkflowRunner. Wire one via factory or test setup before using mcp_tool_call stages.',
});
