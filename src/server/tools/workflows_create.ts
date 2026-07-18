import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';
import { WorkflowsRepository } from '../../core/auto-code/workflows/workflows-repository.js';
import type { WorkflowDefinition } from '../../core/auto-code/workflows/types/index.js';
import { writeFolderWorkflowTemplate } from '../features/auto-code-template-settings.js';
import { workflowValidationEnvelope } from './workflow-tool-helpers.js';

/**
 * Create a custom Auto-code workflow row from a WorkflowDefinition —
 * the write half of the external agent's authoring loop
 * (workflows_environment → workflows_validate → workflows_create).
 *
 * Validation is the repository's own save stack (strict linear parser
 * for pure cli_agent/mcp_tool_call definitions, full v2 schema for
 * drafts), so anything workflows_validate accepted lands here intact.
 * Failures come back as the same structured
 * `invalid_workflow_definition` + issues[] envelope.
 *
 * `setAsFolderDefault: true` also pins the new workflow as the
 * folder's default (mirrors the row badge AND the folder settings
 * selection, same as the HTTP create route).
 */
export const workflowsCreateTool = defineTool({
  name: 'workflows_create',
  description:
    'Create a custom Auto-code workflow in a folder from a WorkflowDefinition JSON. Validates with the same stack as workflows_validate — on failure returns {error: "invalid_workflow_definition", message, issues: [{path, message}]} so you can fix and retry. Pass setAsFolderDefault: true to also pin it as the folder default workflow. Returns the created row (id = ULID) — assign it to tickets via notes_update({workflowId}).',
  category: 'create',
  annotations: { destructiveHint: false },
  inputShape: {
    folderId: z
      .string()
      .min(1)
      .describe('The folder that will own the workflow. Must exist.'),
    name: z
      .string()
      .min(1)
      .max(120)
      .describe('Display name for the workflow (unique names recommended).'),
    definition: z
      .record(z.unknown())
      .describe(
        'The WorkflowDefinition JSON (same shape workflows_list returns). Validate first with workflows_validate.',
      ),
    setAsFolderDefault: z
      .boolean()
      .optional()
      .describe(
        'When true, pin this workflow as the folder default (new tickets without a per-ticket override run it).',
      ),
  },
  async handler(input, ctx) {
    if (
      !canPerform('create', ctx, { kind: 'folder', folderId: input.folderId })
    ) {
      return ACCESS_DENIED;
    }
    const folder = ctx.folders.getById(input.folderId);
    if (!folder) {
      return {
        error: 'folder_not_found',
        message: `No folder with id ${input.folderId}.`,
      };
    }

    const repo = new WorkflowsRepository(ctx.db);
    let created;
    try {
      created = repo.create({
        folderId: input.folderId,
        name: input.name,
        // The repository re-validates via parseDraft/parseLinear —
        // the cast only bridges the wire type to the input type.
        definition: input.definition as unknown as WorkflowDefinition,
        isDefault: input.setAsFolderDefault === true,
      });
    } catch (err) {
      return workflowValidationEnvelope(err);
    }

    // Mirror the default pick onto the folder settings selection so
    // the Folder Settings dropdown + the orchestrator's resolver agree
    // with the row badge (same sync as the HTTP create route).
    if (input.setAsFolderDefault === true) {
      writeFolderWorkflowTemplate(
        ctx.settings,
        ctx.db,
        created.folderId,
        created.id,
      );
    }

    ctx.audit.recordWorkflow({
      workflowId: created.id,
      action: 'workflow_create',
      actor: ctx.actor,
    });

    return { ok: true, workflow: created };
  },
});
