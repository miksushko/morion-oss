import type { ToolContext } from '../../tools/types.js';
import type { McpToolDispatcher } from '../../../core/auto-code/workflows/runner.js';
import { AUTO_CODE_ACTOR } from '../../../core/auto-code/actor-constants.js';
import { dispatchMoTool } from '../../../core/concierge/mo-tools.js';
import { ALL_TOOLS } from '../../tools/index.js';
import { extractCostFromData } from './helpers.js';

/**
 * Build the `mcpToolDispatcher` closure passed to WorkflowRunner.
 * Wires `mcp_tool_call` workflow stages through the chat-tier MCP
 * dispatcher so workflows can compose Mo / MCP tools (mo_ask,
 * notes_search, etc.) alongside cli_agent stages. Returns the same
 * envelope `dispatchMoTool` does so the runner branches cleanly on
 * `ok`.
 *
 * Codex P1a (2026-05-10) — actor MUST be `mcp:auto-code`
 * (AUTO_CODE_ACTOR), NOT the HTTP request's `user` actor.
 * canPerform allows everything for non-MCP actors → an HTTP-
 * triggered enqueue running an MCP stage as `user` would
 * bypass MCP permissions on hidden / gated folders. The
 * scheduler-driven path already runs as the auto-code actor;
 * align the HTTP trigger with the same gate. Cloning toolCtx
 * is shallow — every dependency reference stays — only the
 * `actor` field is overridden.
 */
export function buildMcpToolDispatcher(
  toolCtx: ToolContext,
): McpToolDispatcher {
  return async (toolName, args) => {
    const elevatedCtx: ToolContext = {
      ...toolCtx,
      actor: AUTO_CODE_ACTOR,
    };
    const result = await dispatchMoTool(
      ALL_TOOLS,
      { name: toolName, argumentsJson: JSON.stringify(args ?? {}) },
      elevatedCtx,
    );
    if (result && typeof result === 'object' && 'ok' in result && result.ok) {
      // Pass through optional `costUsd` extracted from the data
      // envelope so the runner can roll cost up to the run's
      // `total_cost_usd` (Codex P2c). Tools that return cost
      // populate it (mo_ask, mo_get_context); others pass null.
      const data = (result as { data: unknown }).data;
      const costUsd = extractCostFromData(data);
      return {
        ok: true,
        data,
        ...(costUsd !== null ? { costUsd } : {}),
      };
    }
    const err = result as { error?: string; message?: string };
    return {
      ok: false,
      error: typeof err.error === 'string' ? err.error : 'mcp_tool_failed',
      message: typeof err.message === 'string' ? err.message : undefined,
    };
  };
}
