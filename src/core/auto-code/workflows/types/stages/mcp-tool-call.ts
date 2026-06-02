import { z } from 'zod';

export const McpToolCallStageSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('mcp_tool_call'),
  /** Tool name in the MCP registry — `mo_ask`, `mo_get_context`,
   *  `notes_search`, etc. The runner refuses unknown names at
   *  dispatch time (clean failure, not silent skip). */
  toolName: z.string().min(1),
  /** Arguments forwarded to the tool. String values are run through
   *  the same Mustache renderer as cli_agent prompts so a stage can
   *  reference `{{ticket.body}}` / `{{stages.fix.output.summary}}`.
   *  Non-string values pass through verbatim. */
  argsTemplate: z.record(z.unknown()).default({}),
  /** Maximum attempts before the runner marks the stage `failed`.
   *  Mirrors cli_agent semantics. */
  maxAttempts: z.number().int().min(1).default(1),
  /** Advisory per-stage budget cap in USD. Currently NOT enforced
   *  by the runner (no pre-flight gate equivalent to cli_agent's
   *  BudgetGuard); Mo's tools self-cap via their own per-call
   *  envelope (e.g. `mo_get_context` $0.10 hard cap). The runner
   *  rolls up the tool's reported `costUsd` into the run total
   *  via `extractCostFromData` in the factory's
   *  `mcpToolDispatcher`, so MCP spend appears in
   *  `workflow_runs.total_cost_usd`. The field is preserved on
   *  the snapshot for forward-compat with a future MCP-budget
   *  guard (Codex P2c, 2026-05-10). */
  maxBudgetUsd: z.number().nonnegative().nullable().default(null),
});
