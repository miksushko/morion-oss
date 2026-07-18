import { z } from 'zod';
import { defineTool } from '../types.js';
import { canPerform, ACCESS_DENIED } from '../../../core/permissions/check.js';
import { requireMoEnabledForFolder } from './gate.js';
import {
  resolveGatherProvider,
  resolveWorkflowBuilderModels,
  type ConciergeDepsHost,
} from '../../features/concierge-deps/index.js';
import { buildWorkflowDraft } from '../../../core/auto-code/workflows/build-workflow.js';
import { WorkflowsRepository } from '../../../core/auto-code/workflows/workflows-repository.js';
import { getWorkflowTemplate } from '../../../core/auto-code/workflows/templates.js';
import { writeFolderWorkflowTemplate } from '../../features/auto-code-template-settings.js';
import { workflowValidationEnvelope } from '../workflow-tool-helpers.js';
import type { WorkflowDefinition } from '../../../core/auto-code/workflows/types/index.js';

/**
 * Mo authors an Auto-code workflow from a natural-language instruction
 * (Mo Workflows epic).
 *
 * DRAFT-FIRST by design (the mo_record lesson — no fire-and-forget
 * writes): without `write: true` the tool ONLY drafts — LLM loop on
 * the workflow-builder pipeline model, validated by the exact
 * save-time stack, issues fed back for self-correction (attempt cap).
 * Nothing touches the database; the caller shows the draft to the
 * human.
 *
 * Saving is a second, deterministic call: `write: true` + the approved
 * `definition` passed back verbatim. No LLM involvement on the write
 * path — the tool is stateless between calls, so re-generating on
 * confirmation would silently save something the human never saw.
 */
export const moBuildWorkflowTool = defineTool({
  name: 'mo_build_workflow',
  category: 'create',
  annotations: { destructiveHint: false },
  description:
    'Mo drafts an Auto-code WorkflowDefinition from a natural-language instruction, on the dedicated workflow-builder pipeline model (Settings → Mo). DRAFT-FIRST: without write:true nothing is saved — show the returned definition to the user for approval. To save the approved draft, call again with {write: true, definition: <the draft>, name} (deterministic, no LLM). Optional baseTemplateId starts from a shipped template or a custom workflow in the folder. Requires Mo enabled on the folder + folder create permission. Costs run against the Mo monthly budget.',
  inputShape: {
    folderId: z
      .string()
      .min(1)
      .describe('The folder the workflow is for. Must have Mo enabled.'),
    instruction: z
      .string()
      .min(1)
      .max(4_000)
      .optional()
      .describe(
        'Natural-language description of the desired process. Required for drafting (write omitted/false).',
      ),
    baseTemplateId: z
      .string()
      .optional()
      .describe(
        'Optional starting point: a built-in template id (default-v2, ...) or a custom workflow ULID in this folder.',
      ),
    write: z
      .boolean()
      .optional()
      .describe(
        'true = save the supplied definition (requires `definition`; no LLM call). Omitted/false = draft only.',
      ),
    definition: z
      .record(z.unknown())
      .optional()
      .describe(
        'The approved draft to save. Required with write: true; ignored otherwise.',
      ),
    name: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Workflow name for the write path. Defaults to the definition\'s own name field.',
      ),
    setAsFolderDefault: z
      .boolean()
      .optional()
      .describe('Write path only: pin the saved workflow as the folder default.'),
  },
  async handler(input, ctx) {
    const moGate = requireMoEnabledForFolder(ctx, input.folderId);
    if (moGate) return moGate;
    if (
      !canPerform('create', ctx, { kind: 'folder', folderId: input.folderId })
    ) {
      return ACCESS_DENIED;
    }
    const repo = new WorkflowsRepository(ctx.db);

    // ---------- write path: deterministic save of an approved draft --
    if (input.write === true) {
      if (!input.definition) {
        return {
          error: 'definition_required',
          message:
            'write: true saves a previously drafted definition — pass it back in `definition`.',
        };
      }
      let created;
      try {
        created = repo.create({
          folderId: input.folderId,
          name:
            input.name ??
            ((input.definition as { name?: string }).name || 'Mo-built workflow'),
          definition: input.definition as unknown as WorkflowDefinition,
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
      return { ok: true, written: true, workflow: created };
    }

    // ---------- draft path: LLM loop on the workflow-builder model ---
    if (!input.instruction) {
      return {
        error: 'instruction_required',
        message: 'Drafting needs an `instruction` describing the desired process.',
      };
    }
    if (!ctx.concierge?.budget) {
      return {
        error: 'mo_internal_not_wired',
        message: 'Mo budget tracker is not wired.',
      };
    }
    const budgetStatus = ctx.concierge.budget.status();
    if (!budgetStatus.withinBudget) {
      return {
        reason: 'monthly_cap_reached',
        message: `Monthly Mo budget cap reached ($${budgetStatus.spentMonthUsd.toFixed(2)}) — drafting would exceed it.`,
      };
    }

    const host: ConciergeDepsHost = {
      db: ctx.db,
      notes: ctx.notes,
      folders: ctx.folders,
      comments: ctx.comments,
      settings: ctx.settings,
      concierge: ctx.concierge,
      embeddings: ctx.embeddings,
    };
    const moProvider = resolveGatherProvider(host);
    if (!moProvider) {
      return {
        error: 'mo_provider_unconfigured',
        message:
          'Mo provider is not configured. In Settings → Mo, select a backend, add its key, and set the pipeline models.',
      };
    }
    const models = resolveWorkflowBuilderModels(host);
    if (!models) {
      return {
        error: 'mo_provider_unconfigured',
        message:
          'Workflow-builder pipeline models are not resolvable for the active backend.',
      };
    }

    // Base definition: registry template OR a custom row in THIS folder.
    let baseDefinition: WorkflowDefinition | null = null;
    if (input.baseTemplateId) {
      const template = getWorkflowTemplate(input.baseTemplateId);
      if (template) {
        baseDefinition = template.definition;
      } else {
        const row = repo.getByIdForFolder(input.baseTemplateId, input.folderId);
        if (!row) {
          return {
            error: 'workflow_not_found',
            message: `No template or folder workflow with id ${input.baseTemplateId}.`,
          };
        }
        baseDefinition = row.definition;
      }
    }

    const result = await buildWorkflowDraft({
      provider: moProvider.provider,
      primaryModel: models.primaryModel,
      fallbackModel: models.fallbackModel,
      instruction: input.instruction,
      baseDefinition,
    });

    // Interactive Mo tool spend — same bucket as other mo_* calls.
    ctx.concierge.budget.record({
      kind: 'mo_tool',
      folderId: input.folderId,
      costUsd: result.costUsd,
    });

    if (!result.ok) {
      return {
        error: result.error,
        message: result.message,
        issues: result.issues,
        costUsd: result.costUsd,
        attempts: result.attempts,
      };
    }
    return {
      ok: true,
      written: false,
      definition: result.definition,
      validation: {
        ok: true,
        runnable: result.runnable,
        runnableReason: result.runnableReason,
      },
      costUsd: result.costUsd,
      attempts: result.attempts,
      modelUsed: result.modelUsed,
      message:
        'Draft only — nothing saved. Show the definition to the user; on approval call mo_build_workflow again with {write: true, definition, name}.',
    };
  },
});
