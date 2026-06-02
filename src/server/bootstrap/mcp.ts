import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ZodRawShape } from 'zod';
import { ALL_TOOLS } from '../tools/index.js';
import { isRawContentResult, type ToolContext } from '../tools/types.js';
import type { ToolCategory } from '../../core/settings/repository.js';

/**
 * Builds and returns an MCP server with every Morion tool registered.
 *
 * The `actor` on the shared ToolContext is hydrated from the initialize
 * request's client info (`mcp:<client-name>`), so every mutation written
 * to the audit log tells us which LLM client did it.
 *
 * Settings gating: every registered handler re-reads the master MCP toggle +
 * the per-category toggle on every call. SQLite PK lookups are microseconds
 * and the alternative — caching settings in memory — would lag behind toggles
 * the user flips in another window. The cost of "tools/list still shows the
 * tool while it returns a disabled error envelope" is a documented limitation:
 * Claude Desktop only re-fetches tools/list on initialize, so the user has to
 * accept that disable-while-connected is a no-op for that view.
 */
export function buildMcpServer(contextBase: Omit<ToolContext, 'actor'>): McpServer {
  const server = new McpServer(
    { name: 'morion', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // The actor is updated once the client sends `initialize`. Until then we
  // stamp audit rows with 'mcp:unknown'. The shared ctx reference is mutated
  // in place so all handlers see the latest value.
  const ctx: ToolContext = { ...contextBase, actor: 'mcp:unknown' };

  server.server.oninitialized = () => {
    const info = server.server.getClientVersion();
    // SECURITY: info.name is SELF-REPORTED by the MCP client during
    // initialize. Nothing verifies it — a malicious client can identify
    // as "claude-desktop" to blend in with an audit log. We treat it as
    // a hint, not proof, and sanitize to prevent log-injection: any
    // non-[a-zA-Z0-9_-] character becomes _, capped at 64 chars. The UI
    // shows a "not verified" tooltip on the audit log so users don't
    // mistake the actor string for authenticated identity.
    if (info?.name) {
      const clean = info.name.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
      ctx.actor = `mcp:${clean || 'unknown'}`;
    }
  };

  for (const tool of ALL_TOOLS) {
    const shape = tool.inputShape as ZodRawShape;
    const category = tool.category;
    const annotations = { ...annotationsForCategory(category), ...tool.annotations };
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: shape, annotations },
      async (input: Record<string, unknown>) => {
        const gateError = checkGate(ctx, category);
        if (gateError) {
          return {
            content: [{ type: 'text', text: JSON.stringify(gateError, null, 2) }],
            isError: true,
          };
        }
        const result = await tool.handler(input as never, ctx);
        // Direction P — tools may opt into raw MCP content (e.g. image
        // bytes) by returning the `mcpRawContent(...)` sentinel. The
        // default path JSON-stringifies and wraps in a single text
        // content item, preserving every non-attachment tool's
        // existing contract.
        if (isRawContentResult(result)) {
          return {
            content: result._mcpContent,
            ...(result.isError ? { isError: true } : {}),
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      },
    );
  }

  return server;
}

/**
 * Default MCP behavioural hints derived from a tool's category. Individual
 * tools override these via `ToolDef.annotations` when they diverge — e.g.
 * `notes_append` is a `create`-category tool (adds to body) but its mutation
 * overwrites existing content so it ships `destructiveHint: true`.
 *
 * Per MCP spec: `readOnlyHint` means no environment modification at all;
 * `destructiveHint` only has meaning when `readOnlyHint` is false, and its
 * default on the client side is `true` (assume destructive) — which is why
 * we explicitly set `destructiveHint: false` on non-destructive mutations.
 */
function annotationsForCategory(cat: ToolCategory) {
  switch (cat) {
    case 'read':
      return { readOnlyHint: true };
    case 'create':
      return { destructiveHint: false };
    case 'update':
      return { destructiveHint: true };
    case 'delete':
      return { destructiveHint: true };
  }
}

/**
 * Re-read the MCP gates and return a structured error envelope if the call
 * should be blocked, or null if it's allowed. Uses the `ToolContext`'s shared
 * `settings` repo so flipping a toggle in the UI is visible immediately
 * (no in-process cache).
 */
function checkGate(
  ctx: ToolContext,
  category: ToolCategory,
): { error: string; reason: string } | null {
  const mcp = ctx.settings.getMcpSettings();
  if (!mcp.enabled) {
    return {
      error: 'mcp_disabled',
      reason: 'The Morion server is currently disabled in the notebook settings.',
    };
  }
  if (!mcp.categories[category]) {
    return {
      error: 'mcp_category_disabled',
      reason: `The "${category}" tool category is currently disabled in the notebook settings.`,
    };
  }
  return null;
}

/**
 * Convenience: build + connect stdio transport. Used by the CLI `serve`
 * command. Returns a handle that lets the caller close the transport
 * cleanly on shutdown.
 */
export async function startMcpStdio(
  contextBase: Omit<ToolContext, 'actor'>,
): Promise<{ server: McpServer; transport: StdioServerTransport }> {
  const server = buildMcpServer(contextBase);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}
