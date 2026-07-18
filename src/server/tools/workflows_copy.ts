import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';
import { WorkflowsRepository } from '../../core/auto-code/workflows/workflows-repository.js';
import { getWorkflowTemplate } from '../../core/auto-code/workflows/templates.js';
import { writeFolderWorkflowTemplate } from '../features/auto-code-template-settings.js';
import { workflowValidationEnvelope } from './workflow-tool-helpers.js';
import type { WorkflowDefinition } from '../../core/auto-code/workflows/types/index.js';

/**
 * Copy a workflow into a folder as a fresh editable row. Two source
 * kinds, one tool:
 *
 *   - a built-in template id (`default-v2`, ...) — "start from a
 *     template" without round-tripping the JSON through the agent;
 *   - a custom row ULID from ANY folder — the first cross-folder
 *     path (the HTTP clone route is same-folder only; the repository
 *     header marks cross-folder copy as the intended extension).
 *
 * Permission model: copying a custom row requires READ on the source
 * folder (you are exfiltrating its definition) plus CREATE on the
 * target; templates are public constants, so only the target gate
 * applies. The copy always lands with a fresh ULID and re-validated
 * definition (repository `create` does both).
 */
export const workflowsCopyTool = defineTool({
  name: 'workflows_copy',
  description:
    'Copy an Auto-code workflow into a folder as a fresh editable row. sourceWorkflowId is either a built-in template id (default-v2, ...) or a custom row ULID from any folder (cross-folder copy: needs read permission on the source folder + create on the target). The copy gets a new ULID and is never the default unless setAsFolderDefault: true. Default name is the source name, suffixed with " (copy)" on collision. Use this before workflows_update when starting from a template — templates themselves are immutable.',
  category: 'create',
  annotations: { destructiveHint: false },
  inputShape: {
    sourceWorkflowId: z
      .string()
      .min(1)
      .describe(
        'Built-in template id (see workflows_list) OR the ULID of a custom workflow row in any folder.',
      ),
    targetFolderId: z
      .string()
      .min(1)
      .describe('The folder that will own the copy. Must exist.'),
    name: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Name for the copy. Defaults to the source name (with " (copy)" appended on collision).',
      ),
    setAsFolderDefault: z
      .boolean()
      .optional()
      .describe(
        'When true, pin the copy as the target folder default workflow.',
      ),
  },
  async handler(input, ctx) {
    if (
      !canPerform('create', ctx, {
        kind: 'folder',
        folderId: input.targetFolderId,
      })
    ) {
      return ACCESS_DENIED;
    }
    const target = ctx.folders.getById(input.targetFolderId);
    if (!target) {
      return {
        error: 'folder_not_found',
        message: `No folder with id ${input.targetFolderId}.`,
      };
    }

    const repo = new WorkflowsRepository(ctx.db);

    // Resolve the source: template registry first, then custom rows.
    let sourceName: string;
    let sourceDefinition: WorkflowDefinition;
    const template = getWorkflowTemplate(input.sourceWorkflowId);
    if (template) {
      sourceName = template.label;
      sourceDefinition = template.definition;
    } else {
      const row = repo.getById(input.sourceWorkflowId);
      if (!row) {
        return {
          error: 'workflow_not_found',
          message: `No workflow or template with id ${input.sourceWorkflowId}.`,
        };
      }
      // Cross-folder read gate: the caller must be able to SEE the
      // source folder to copy definitions out of it. Same envelope as
      // not-found so hidden-folder existence doesn't leak.
      if (
        !canPerform('read', ctx, { kind: 'folder', folderId: row.folderId })
      ) {
        return {
          error: 'workflow_not_found',
          message: `No workflow or template with id ${input.sourceWorkflowId}.`,
        };
      }
      sourceName = row.name;
      sourceDefinition = row.definition;
    }

    // Default name: source name, de-collided against the target
    // folder's existing rows with " (copy)" / " (copy N)" suffixes.
    let name = input.name;
    if (!name) {
      const taken = new Set(
        repo.listSummariesForFolder(input.targetFolderId).map((w) => w.name),
      );
      name = sourceName;
      if (taken.has(name)) {
        name = `${sourceName} (copy)`;
        for (let n = 2; taken.has(name); n++) {
          name = `${sourceName} (copy ${n})`;
        }
      }
    }

    let created;
    try {
      created = repo.create({
        folderId: input.targetFolderId,
        name,
        definition: sourceDefinition,
        isDefault: input.setAsFolderDefault === true,
      });
    } catch (err) {
      return workflowValidationEnvelope(err);
    }

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
