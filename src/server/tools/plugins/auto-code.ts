import type { ZodRawShape } from 'zod';
import type { ToolDef } from '../types.js';
import { workflowsListTool } from '../workflows_list.js';
import { moCheckWorkflowTool } from '../mo/mo_check_workflow.js';
import type { McpToolPlugin } from './types.js';

/**
 * Auto-code MCP tool plugin. MASTER ONLY — excluded from the public OSS
 * export (scripts/export-public.mjs EXCLUDE list). In the public build,
 * `plugins/index.public.ts` (an empty list, swapped to index.ts at
 * export) takes over so `ALL_TOOLS` drops these two tools (49 → 47).
 *
 *   - `mo_check_workflow` — workflow pre-flight gate (auto-code only)
 *   - `workflows_list` — list workflow templates + custom definitions
 *
 * Appended AFTER the core tools, so the discovery order of the core
 * surface is unchanged.
 */
export const autoCodeToolPlugin: McpToolPlugin = {
  tools: [moCheckWorkflowTool, workflowsListTool] as ToolDef<ZodRawShape>[],
};

// Re-exported for master-only tests (tests/mo-check-workflow.test.ts,
// tests/mcp-tools-workflows-list.test.ts) which import these by name.
// Both tests are excluded from the public export alongside this file.
export { workflowsListTool, moCheckWorkflowTool };
