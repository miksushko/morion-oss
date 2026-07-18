import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';
import { WorkflowsRepository } from '../../core/auto-code/workflows/workflows-repository.js';
import type { WorkflowDefinition } from '../../core/auto-code/workflows/types/index.js';
import { getWorkflowTemplate } from '../../core/auto-code/workflows/templates.js';
import { writeFolderWorkflowTemplate } from '../features/auto-code-template-settings.js';
import { workflowValidationEnvelope } from './workflow-tool-helpers.js';

/**
 * Update a custom Auto-code workflow row (name and/or definition).
 * CUSTOM ROWS ONLY — built-in templates are immutable constants; to
 * tweak one, copy it into the folder first (workflows_copy) and edit
 * the copy.
 *
 * Editing while runs are in flight is allowed by design: every run
 * snapshots its graph immutably (`workflow_runs.graph_snapshot_json`)
 * at start, so running runs finish on the old definition and only
 * FUTURE runs pick up the edit (parity with the HTTP PUT route,
 * decision 2026-07-14).
 */
export const workflowsUpdateTool = defineTool({
  name: 'workflows_update',
  description:
    'Update a custom Auto-code workflow (name and/or definition). Only custom rows (ULID ids) can be edited — built-in template ids (default-v2, ...) return template_immutable; copy them with workflows_copy first. Validation failures return {error: "invalid_workflow_definition", message, issues} for fix-and-retry. In-flight runs are unaffected (each run snapshots its graph at start); edits apply to future runs only. Pass setAsFolderDefault: true to also pin it as the folder default.',
  category: 'update',
  annotations: { destructiveHint: false },
  inputShape: {
    workflowId: z
      .string()
      .min(1)
      .describe('ULID of the custom workflow row to update.'),
    folderId: z
      .string()
      .min(1)
      .describe(
        'The folder that owns the workflow (folder isolation gate — a workflow from another folder returns workflow_not_found).',
      ),
    name: z.string().min(1).max(120).optional().describe('New display name.'),
    definition: z
      .record(z.unknown())
      .optional()
      .describe(
        'Replacement WorkflowDefinition JSON. Omit to keep the current one (e.g. rename-only).',
      ),
    setAsFolderDefault: z
      .boolean()
      .optional()
      .describe(
        'When true, pin this workflow as the folder default. Omitting or false leaves the current default untouched.',
      ),
  },
  async handler(input, ctx) {
    if (
      !canPerform('update', ctx, { kind: 'folder', folderId: input.folderId })
    ) {
      return ACCESS_DENIED;
    }
    if (getWorkflowTemplate(input.workflowId)) {
      return {
        error: 'template_immutable',
        message: `"${input.workflowId}" is a built-in template and cannot be edited. Copy it into the folder with workflows_copy, then update the copy.`,
      };
    }
    const repo = new WorkflowsRepository(ctx.db);
    const existing = repo.getByIdForFolder(input.workflowId, input.folderId);
    if (!existing) {
      return {
        error: 'workflow_not_found',
        message: `No workflow ${input.workflowId} in folder ${input.folderId}.`,
      };
    }

    let updated;
    try {
      updated = repo.update(input.workflowId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        // The repository re-validates via parseDraft/parseLinear —
        // the cast only bridges the wire type to the input type.
        ...(input.definition !== undefined
          ? {
              definition:
                input.definition as unknown as WorkflowDefinition,
            }
          : {}),
        ...(input.setAsFolderDefault === true ? { isDefault: true } : {}),
      });
    } catch (err) {
      return workflowValidationEnvelope(err);
    }
    if (!updated) {
      return {
        error: 'workflow_not_found',
        message: `No workflow ${input.workflowId} in folder ${input.folderId}.`,
      };
    }

    // Same sync as the HTTP PUT route: only an explicit true mirrors
    // onto the folder settings selection — false/omitted must not
    // reset the dropdown.
    if (input.setAsFolderDefault === true && updated.isDefault) {
      writeFolderWorkflowTemplate(
        ctx.settings,
        ctx.db,
        updated.folderId,
        updated.id,
      );
    }

    ctx.audit.recordWorkflow({
      workflowId: updated.id,
      action: 'workflow_update',
      actor: ctx.actor,
    });

    return { ok: true, workflow: updated };
  },
});
