import { z } from 'zod';
import { defineTool } from './types.js';
import { WorkflowDefinitionSchema } from '../../core/auto-code/workflows/types/index.js';
import {
  LinearWorkflowError,
  isDraftWorkflowDefinition,
  parseRunnableWorkflow,
} from '../../core/auto-code/workflows/parse-linear.js';

/**
 * Dry-run validation of a WorkflowDefinition — the self-correction
 * loop for external agents authoring workflow JSON:
 *
 *   build → workflows_validate → fix issues → workflows_create
 *
 * Runs the exact stack the write path runs (`WorkflowDefinitionSchema`
 * incl. the v2 superRefine invariants, plus the linear edge-chain gate
 * for non-draft definitions), so a `{ok: true}` here guarantees
 * `workflows_create` will accept the same JSON. Additionally reports
 * whether the definition is RUNNABLE by the current runner — a valid
 * draft can be saveable but not yet dispatchable (e.g. a `branch`
 * stage, reserved for a future runner phase).
 *
 * No writes, no side effects.
 */
export const workflowsValidateTool = defineTool({
  name: 'workflows_validate',
  description:
    'Dry-run validate an Auto-code WorkflowDefinition without saving anything. Runs the same validation stack as workflows_create, so {ok: true} guarantees the JSON will save. Returns {ok, summary: {stageCount, agentChain, isDraft, runnable, runnableReason}} on success, or {error: "invalid_workflow_definition", message, issues: [{path, message}]} listing every violation so you can fix and retry. Use in a build → validate → fix → create loop. read-only, no side effects.',
  category: 'read',
  inputShape: {
    definition: z
      .record(z.unknown())
      .describe(
        'The WorkflowDefinition JSON to validate (same shape workflows_list returns in its `definition` fields).',
      ),
  },
  async handler(input) {
    const parsed = WorkflowDefinitionSchema.safeParse(input.definition);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({
        path: i.path.join('.') || 'definition',
        message: i.message,
      }));
      return {
        error: 'invalid_workflow_definition',
        message: `${issues[0].path}: ${issues[0].message}`,
        issues,
      };
    }

    const def = parsed.data;
    const isDraft = isDraftWorkflowDefinition(def);

    // The runner gate. For non-draft (pure cli_agent / mcp_tool_call)
    // definitions this doubles as the SAVE gate — the repository
    // routes them through the strict linear parser, so a failure here
    // means workflows_create would reject the JSON too.
    let runnable = true;
    let runnableReason: string | null = null;
    try {
      parseRunnableWorkflow(def);
    } catch (err) {
      if (err instanceof LinearWorkflowError) {
        if (!isDraft) {
          return {
            error: 'invalid_workflow_definition',
            message: err.message,
            issues: [{ path: 'definition', message: err.message }],
          };
        }
        runnable = false;
        runnableReason = err.message;
      } else {
        throw err;
      }
    }

    return {
      ok: true,
      summary: {
        stageCount: def.stages.length,
        agentChain: def.stages
          .filter((s) => s.kind === 'cli_agent')
          .map((s) => (s as { agent: string }).agent),
        isDraft,
        runnable,
        runnableReason,
      },
    };
  },
});
