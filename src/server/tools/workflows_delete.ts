import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';
import { WorkflowsRepository } from '../../core/auto-code/workflows/workflows-repository.js';
import {
  DEFAULT_TEMPLATE_ID,
  getWorkflowTemplate,
} from '../../core/auto-code/workflows/templates.js';
import {
  readFolderWorkflowTemplate,
  writeFolderWorkflowTemplate,
} from '../features/auto-code-template-settings.js';
import { recordStickyDeleteForRow } from '../routes/concierge/auto-code-workflows/sticky-delete.js';

/**
 * Delete a custom Auto-code workflow row — the MCP mirror of the HTTP
 * DELETE route, including all three cleanup steps:
 *
 *   1. folder default reset to `DEFAULT_TEMPLATE_ID` when the setting
 *      pointed at the deleted row;
 *   2. per-ticket `notes.workflow_id` overrides swept to NULL;
 *   3. sticky-delete bookkeeping so the list-endpoint seeding doesn't
 *      resurrect a seeded-template-derived row.
 *
 * category 'delete' — in Mo chat this is the one category that pauses
 * the loop for a user approval card, which is exactly the friction a
 * workflow deletion deserves.
 */
export const workflowsDeleteTool = defineTool({
  name: 'workflows_delete',
  description:
    'Delete a custom Auto-code workflow row (ULID ids only — built-in template ids return template_immutable). Cleans up everything the row touched: resets the folder default to the built-in default when it pointed here, clears per-ticket workflow_id overrides (they revert to the folder default), and records sticky-delete so seeding does not resurrect the row. Destructive and unrecoverable — the definition JSON is gone; consider workflows_list first to save a copy.',
  category: 'delete',
  inputShape: {
    workflowId: z
      .string()
      .min(1)
      .describe('ULID of the custom workflow row to delete.'),
    folderId: z
      .string()
      .min(1)
      .describe(
        'The folder that owns the workflow (folder isolation gate — a workflow from another folder returns workflow_not_found).',
      ),
  },
  async handler(input, ctx) {
    if (
      !canPerform('delete', ctx, { kind: 'folder', folderId: input.folderId })
    ) {
      return ACCESS_DENIED;
    }
    if (getWorkflowTemplate(input.workflowId)) {
      return {
        error: 'template_immutable',
        message: `"${input.workflowId}" is a built-in template and cannot be deleted. Only custom rows (ULID ids) can.`,
      };
    }
    const repo = new WorkflowsRepository(ctx.db);
    const target = repo.getByIdForFolder(input.workflowId, input.folderId);
    if (!target) {
      return {
        error: 'workflow_not_found',
        message: `No workflow ${input.workflowId} in folder ${input.folderId}.`,
      };
    }

    // Same cleanup order as the HTTP DELETE route.
    let clearedFolderDefault = false;
    if (readFolderWorkflowTemplate(ctx.settings, target.folderId) === target.id) {
      writeFolderWorkflowTemplate(
        ctx.settings,
        ctx.db,
        target.folderId,
        DEFAULT_TEMPLATE_ID,
      );
      clearedFolderDefault = true;
    }
    const sweep = ctx.db
      .prepare(`UPDATE notes SET workflow_id = NULL WHERE workflow_id = ?`)
      .run(target.id);
    recordStickyDeleteForRow(ctx.settings, target.folderId, target.id);
    const deleted = repo.delete(target.id);
    if (!deleted) {
      return {
        error: 'workflow_not_found',
        message: `No workflow ${input.workflowId} in folder ${input.folderId}.`,
      };
    }

    ctx.audit.recordWorkflow({
      workflowId: target.id,
      action: 'workflow_delete',
      actor: ctx.actor,
    });

    return {
      ok: true,
      deletedWorkflowId: target.id,
      clearedFolderDefault,
      clearedTicketCount: sweep.changes ?? 0,
    };
  },
});
