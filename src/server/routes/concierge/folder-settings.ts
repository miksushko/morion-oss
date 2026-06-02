/**
 * Per-folder Mo + auto-code settings GET/PUT (Access Permissions tab).
 *
 * - GET /api/concierge/folders/:id/settings  — Pro-open read.
 * - PUT /api/concierge/folders/:id/settings  — Pro-gated update with
 *   validation + cascade + toggle-off side effects.
 *
 * PUT runs an ordered chain of guards / cascades / side-effects:
 *   1. linkedRepoPath validation (absolute path → exists → `.git`)
 *   2. autoCodeEnabled requires linkedRepoPath
 *   3. Cascade: Mo `enabled: false` forces `autoCodeEnabled: false`
 *   4. Mo gate: autoCodeEnabled requires Mo enabled
 *   5. Toggle-off killer: cancel in-flight runs on Mo or auto-code
 *      flipping off — covers BOTH engines (mo_agent_queue +
 *      workflow_runs) via the dispatcher's unified `cancelFolder`.
 *   6. Persist + write virtual fields (workflowTemplate +
 *      intakeInstruction + autoMergeEnabled) to settings KV.
 *
 * Extracted from `src/server/routes/concierge.ts` (slice 11/N of the
 * route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F). Pure code-
 * motion — behaviour unchanged.
 */

import type { Hono } from 'hono';
import { buildAutoCodeDispatcher } from '../../features/auto-code-factory/index.js';
import {
  readFolderAutoMerge,
  readFolderIntakeInstruction,
  readFolderWorkflowTemplate,
  syncRowDefaultWithFolderSelection,
  validateFolderWorkflowSelection,
  writeFolderAutoMerge,
  writeFolderIntakeInstruction,
  writeFolderWorkflowTemplate,
} from '../../features/auto-code-template-settings.js';
import type { ToolContext } from '../../tools/types.js';
import { folderSettingsSchema } from './schemas.js';
import { requireConciergeDeps, validateLinkedRepo } from './shared.js';

export function registerFolderSettingsRoutes(
  app: Hono,
  ctx: ToolContext,
): void {
  app.get('/api/concierge/folders/:id/settings', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const folderId = c.req.param('id');
    const folder = ctx.folders.getById(folderId);
    if (!folder) return c.json({ error: 'folder_not_found' }, 404);
    const s = bag.bag.folderSettings.getOrDefault(folderId);
    const workflowTemplate = readFolderWorkflowTemplate(ctx.settings, folderId);
    const intakeInstruction = readFolderIntakeInstruction(ctx.settings, folderId);
    const autoMergeEnabled = readFolderAutoMerge(ctx.settings, folderId);
    return c.json({ ...s, workflowTemplate, intakeInstruction, autoMergeEnabled });
  });

  app.put('/api/concierge/folders/:id/settings', async (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const folderId = c.req.param('id');
    if (!ctx.folders.getById(folderId)) return c.json({ error: 'folder_not_found' }, 404);
    const patch = folderSettingsSchema.parse(await c.req.json());

    // Per-folder workflow template lives in workspace settings KV,
    // not the folder_settings row. Pull it out of the patch before
    // anything touches the repo so the validation surfaces a clean
    // 422 + the row update doesn't choke on an unknown column.
    const workflowTemplatePatch = patch.workflowTemplate;
    delete (patch as Record<string, unknown>).workflowTemplate;
    if (workflowTemplatePatch !== undefined) {
      // Accept EITHER a registry template id OR a `workflows.id`
      // ULID (Этап 2 — user-defined custom workflows). Validator
      // checks both. A typo or a stale value lands as 422 instead
      // of silently writing through.
      if (!validateFolderWorkflowSelection(ctx.db, folderId, workflowTemplatePatch)) {
        return c.json(
          {
            error: 'unknown_workflow_template',
            message: `Unknown workflow template id "${workflowTemplatePatch}".`,
          },
          422,
        );
      }
    }

    // Same shape as workflowTemplate — virtual settings-KV field
    // pulled out of the patch before the row update. Free text; the
    // helper enforces the max-length cap. Empty string clears back to
    // the workflow's own default `mo_start.instruction`.
    const intakeInstructionPatch = patch.intakeInstruction;
    delete (patch as Record<string, unknown>).intakeInstruction;

    // Auto-merge toggle is also a virtual settings-KV field —
    // pull it out before the row update so an unknown column write
    // doesn't choke. Patched value lands via `writeFolderAutoMerge`
    // below alongside workflowTemplate / intakeInstruction.
    const autoMergePatch = patch.autoMergeEnabled;
    delete (patch as Record<string, unknown>).autoMergeEnabled;

    // Auto-code path validation. Run BEFORE the repo write so a bad
    // path can't half-persist. Two checks:
    //
    //   1. If `linkedRepoPath` is being set to a string, it must be an
    //      absolute path pointing at an existing git repo (`.git` entry
    //      present — works for both classic repos and worktrees, where
    //      `.git` is a file pointing at the parent's gitdir).
    //   2. If the resulting state has `autoCodeEnabled = true` AND
    //      `linkedRepoPath = null`, reject — the loop has nothing to
    //      run against. Mirrors the umbrella spec step 1: "включении
    //      [auto-code] происходит проверка".
    if (patch.linkedRepoPath !== undefined && patch.linkedRepoPath !== null) {
      const pathCheck = validateLinkedRepo(patch.linkedRepoPath);
      if (!pathCheck.ok) {
        return c.json(
          { error: 'invalid_linked_repo', message: pathCheck.error },
          422,
        );
      }
    }
    const existing = bag.bag.folderSettings.getOrDefault(folderId);
    const resolvedRepo =
      patch.linkedRepoPath === undefined
        ? existing.linkedRepoPath
        : patch.linkedRepoPath;
    const resolvedAutoCode =
      patch.autoCodeEnabled === undefined
        ? existing.autoCodeEnabled
        : patch.autoCodeEnabled;
    if (resolvedAutoCode && !resolvedRepo) {
      return c.json(
        {
          error: 'linked_repo_required',
          message: 'Pick a git repo for this folder before enabling auto-code.',
        },
        422,
      );
    }

    // Cascade: when Mo flips off → auto-code MUST flip off too +
    // any in-flight queue rows get killed. Run BEFORE the
    // mo_required check so Mo-disable doesn't 422 itself.
    if (
      patch.enabled === false &&
      existing.enabled === true &&
      existing.autoCodeEnabled
    ) {
      patch.autoCodeEnabled = false;
    }

    // Mo MUST be enabled when auto-code is on. Per umbrella spec
    // step 5-12, Mo orchestrates the auto-code loop — without Mo
    // there's no Mo-style comment writes / lesson records on
    // completion, no Mo-mediated escalation, etc. Gate at the
    // backend so the toggle can't get out of sync with Mo's state.
    const resolvedMoEnabled =
      patch.enabled === undefined ? existing.enabled : patch.enabled;
    const resolvedAutoCodeAfterCascade =
      patch.autoCodeEnabled === undefined
        ? existing.autoCodeEnabled
        : patch.autoCodeEnabled;
    if (resolvedAutoCodeAfterCascade && !resolvedMoEnabled) {
      return c.json(
        {
          error: 'mo_required',
          message:
            'Auto-code is orchestrated by Mo; enable Mo for this folder first.',
        },
        422,
      );
    }

    // Auto-code toggle-off (sub-ticket 01KQEED9ARX0QZ25S775WDBQC1).
    // When the user flips `auto_code_enabled` from true to false we
    // need to stop in-flight work BEFORE returning, so the UI sees
    // a stable post-toggle state (no orphaned `fix_running` rows on
    // the next render). The killer is idempotent + tolerant of
    // missing data, so calling it on a fresh row-less folder is a
    // free no-op.
    //
    // Triggers in either of two cases:
    //   1. Direct toggle-off: explicit `autoCodeEnabled: false` in
    //      the patch while it was previously true.
    //   2. Cascade: Mo `enabled: false` flipped above — patch.autoCodeEnabled
    //      now is false (forced by the cascade), but existing was true.
    // Toggle-off cancellation now spans BOTH engines via the
    // dispatcher. A user who flipped `auto_code.use_workflow_runner`
    // recently may have rows in both `mo_agent_queue` and
    // `workflow_runs` — catching only one would leave the other
    // engine running invisibly.
    let cancelSummary: Awaited<
      ReturnType<NonNullable<Awaited<ReturnType<typeof buildAutoCodeDispatcher>>>['cancelFolder']>
    > | null = null;
    const isToggleOff =
      patch.autoCodeEnabled === false && existing.autoCodeEnabled === true;
    if (isToggleOff && existing.linkedRepoPath) {
      try {
        const dispatcher = await buildAutoCodeDispatcher(ctx);
        cancelSummary = await dispatcher.cancelFolder(folderId, 'toggle_off');
      } catch (err) {
        // Killer should never throw — if it does, surface but
        // continue with the settings update so the user's toggle
        // sticks. Activity surface (#10) will show the partial
        // cleanup state.
        console.error('[auto-code] toggle-off killer threw:', err);
      }
    }

    const updated = bag.bag.folderSettings.update(folderId, patch);
    if (workflowTemplatePatch !== undefined) {
      writeFolderWorkflowTemplate(
        ctx.settings,
        ctx.db,
        folderId,
        workflowTemplatePatch,
      );
      // Mirror the pick onto `workflows.is_default` so the badge in
      // the workflows-list popup never disagrees with this dropdown
      // (user feedback 2026-05-18 on follow-up to ticket
      // 01KRWQPDKQ2RZMDBJZ5KN0B7YE — the two surfaces used to drift).
      syncRowDefaultWithFolderSelection(
        ctx.db,
        folderId,
        workflowTemplatePatch,
      );
    }
    if (intakeInstructionPatch !== undefined) {
      writeFolderIntakeInstruction(ctx.settings, folderId, intakeInstructionPatch);
    }
    if (autoMergePatch !== undefined) {
      writeFolderAutoMerge(ctx.settings, folderId, autoMergePatch);
    }
    const workflowTemplate = readFolderWorkflowTemplate(ctx.settings, folderId);
    const intakeInstruction = readFolderIntakeInstruction(ctx.settings, folderId);
    const autoMergeEnabled = readFolderAutoMerge(ctx.settings, folderId);
    const updatedWithTemplate = {
      ...updated,
      workflowTemplate,
      intakeInstruction,
      autoMergeEnabled,
    };
    if (cancelSummary) {
      // Flatten UnifiedCancelSummary into a back-compat shape that
      // keeps `cancelledCount` (UI hasn't been updated for the
      // workflow-runner split yet — T7.C). Total = legacy queue
      // cancellations + workflow_runs cancellations.
      const cancelledCount =
        (cancelSummary.legacy?.cancelledCount ?? 0) +
        cancelSummary.workflowRunIds.length;
      return c.json({
        ...updatedWithTemplate,
        autoCodeCancelSummary: {
          ...(cancelSummary.legacy ?? {
            cancelledCount: 0,
            signaledPids: [],
            forceKilledPids: [],
            worktreesRemoved: 0,
            worktreeRemovalErrors: [],
          }),
          cancelledCount,
          workflowRunIds: cancelSummary.workflowRunIds,
        },
      });
    }
    return c.json(updatedWithTemplate);
  });
}
