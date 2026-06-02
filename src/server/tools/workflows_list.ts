import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';
import {
  listWorkflowTemplates,
} from '../../core/auto-code/workflows/templates.js';
import { WorkflowsRepository } from '../../core/auto-code/workflows/workflows-repository.js';
import { readFolderWorkflowTemplate } from '../features/auto-code-template-settings.js';

/**
 * List every Auto-code workflow available for a folder — built-in
 * templates AND user-defined custom rows — including full
 * `WorkflowDefinition`s so an agent can inspect stages and pick the
 * right one before assigning it per-ticket via
 * `notes_update({workflowId})`.
 *
 * Ticket 01KRWQPDKQ2RZMDBJZ5KN0B7YE — "Auto-code: make Coding
 * Workflow selectable, before execution". The agent's intended
 * flow:
 *
 *   1. `workflows_list({folderId})` — discover candidates.
 *   2. Inspect each definition (stage kinds, agents, prompts).
 *   3. `notes_update({id, workflowId})` — pin the ticket to the chosen
 *      one. The ticket must NOT have an active run; the per-ticket
 *      override takes precedence over the folder-level default.
 *
 * read-only.
 */
export const workflowsListTool = defineTool({
  name: 'workflows_list',
  description:
    'List Auto-code workflows available for a folder, with full WorkflowDefinitions. Use this BEFORE calling `notes_update({workflowId})` so you know which ids are valid. Returns built-in templates (id = "default-v2", "bug-fix-v2", ...) AND custom workflow rows (id = ULID). The `isFolderDefault` flag marks the folder\'s currently pinned default. read-only.',
  category: 'read',
  inputShape: {
    folderId: z
      .string()
      .min(1)
      .describe('The folder whose workflows to enumerate. Must exist.'),
  },
  async handler(input, ctx) {
    if (!canPerform('read', ctx, { kind: 'folder', folderId: input.folderId })) {
      return ACCESS_DENIED;
    }
    const folder = ctx.folders.getById(input.folderId);
    if (!folder) {
      return { error: 'folder_not_found', message: `No folder with id ${input.folderId}.` };
    }
    const pinnedId = readFolderWorkflowTemplate(ctx.settings, input.folderId);
    const repo = new WorkflowsRepository(ctx.db);

    const templates = listWorkflowTemplates().map((t) => ({
      id: t.id,
      kind: 'template' as const,
      name: t.label,
      description: t.description,
      isFolderDefault: t.id === pinnedId,
      agentChain: t.agentChain,
      requiredAgents: t.requiredAgents,
      optionalAgents: t.optionalAgents,
      definition: t.definition,
    }));

    const custom = repo.listForFolder(input.folderId).map((row) => ({
      id: row.id,
      kind: 'custom' as const,
      name: row.name,
      description: null,
      isFolderDefault: row.id === pinnedId,
      isDefault: row.isDefault,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      definition: row.definition,
    }));

    return {
      folder: { id: folder.id, name: folder.name },
      folderDefaultWorkflowId: pinnedId,
      workflows: [...templates, ...custom],
    };
  },
});
