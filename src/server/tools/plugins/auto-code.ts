import type { ZodRawShape } from 'zod';
import type { ToolDef } from '../types.js';
import { workflowsListTool } from '../workflows_list.js';
import { workflowsEnvironmentTool } from '../workflows_environment.js';
import { workflowsValidateTool } from '../workflows_validate.js';
import { workflowsCreateTool } from '../workflows_create.js';
import { workflowsUpdateTool } from '../workflows_update.js';
import { workflowsCopyTool } from '../workflows_copy.js';
import { workflowsDeleteTool } from '../workflows_delete.js';
import { moCheckWorkflowTool } from '../mo/mo_check_workflow.js';
import { moBuildWorkflowTool } from '../mo/mo_build_workflow.js';
import type { McpToolPlugin } from './types.js';

/**
 * Auto-code MCP tool plugin. MASTER ONLY — excluded from the public OSS
 * export (scripts/export-public.mjs EXCLUDE list). In the public build,
 * `plugins/index.public.ts` (an empty list, swapped to index.ts at
 * export) takes over so `ALL_TOOLS` drops these tools.
 *
 *   - `mo_check_workflow` — workflow pre-flight gate (auto-code only)
 *   - `workflows_list` — list workflow templates + custom definitions
 *   - `workflows_environment` — installed CLI agents + configured
 *     backends + folder auto-code state
 *   - `workflows_validate` — dry-run WorkflowDefinition validation
 *   - `workflows_create` / `workflows_update` — custom workflow writes
 *     (folder create/update permission bits + workflow_* audit rows)
 *   - `workflows_copy` — template → folder or cross-folder row copy
 *   - `workflows_delete` — custom row delete + cleanup (category
 *     'delete' → Mo-chat approval card)
 *   - `mo_build_workflow` — Mo drafts a definition on the
 *     workflow-builder pipeline model (draft-first; explicit write)
 *
 * Appended AFTER the core tools, so the discovery order of the core
 * surface is unchanged.
 */
export const autoCodeToolPlugin: McpToolPlugin = {
  tools: [
    moCheckWorkflowTool,
    workflowsListTool,
    workflowsEnvironmentTool,
    workflowsValidateTool,
    workflowsCreateTool,
    workflowsUpdateTool,
    workflowsCopyTool,
    workflowsDeleteTool,
    moBuildWorkflowTool,
  ] as ToolDef<ZodRawShape>[],
};

// Re-exported for master-only tests (tests/mo-check-workflow.test.ts,
// tests/mcp-tools-workflows-list.test.ts) which import these by name.
// The tests are excluded from the public export alongside this file.
export {
  workflowsListTool,
  workflowsEnvironmentTool,
  workflowsValidateTool,
  workflowsCreateTool,
  workflowsUpdateTool,
  workflowsCopyTool,
  workflowsDeleteTool,
  moBuildWorkflowTool,
  moCheckWorkflowTool,
};
