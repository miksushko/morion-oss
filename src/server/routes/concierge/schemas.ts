/**
 * Top-level Zod schemas shared across concierge HTTP routes.
 *
 * Extracted from `src/server/routes/concierge.ts` as part of the
 * route-file split (ticket 01KRJYX50FMDQ94V3464T56K5F). Schemas that
 * are scoped to a single handler (e.g. cluster sections patch, topic
 * cleanup body) stay inline in the handler — moving them out would
 * separate validation from its only consumer.
 */

import { z } from 'zod';
import { WorkflowDefinitionSchema } from '../../../core/auto-code/workflows/types/index.js';

export const folderSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  // Auto-code Phase 1 — per-folder linked git repo + toggle. Routes
  // validate disk state before persisting (path exists + .git/ exists);
  // see the PUT handler. `null` clears the link.
  linkedRepoPath: z.string().min(1).max(4_096).nullable().optional(),
  autoCodeEnabled: z.boolean().optional(),
  // Per-folder cap on concurrent in-flight auto-code runs. Real column
  // on `concierge_folder_settings` (migration 0040) — flows straight to
  // the repo update. `null` clears back to the workspace default
  // (MAX_INFLIGHT_PER_FOLDER). Bounded to keep a typo from spawning an
  // unbounded number of agent worktrees.
  autoCodeConcurrency: z.number().int().min(1).max(20).nullable().optional(),
  // Per-folder workflow template id. Validated against the templates
  // registry; unknown ids 422. Lives in workspace settings KV (not
  // the folder_settings table) so no migration was needed —
  // surfaced here as a virtual field for UI symmetry.
  workflowTemplate: z.string().min(1).max(64).optional(),
  // Per-folder intake-instruction override for the workflow's
  // `mo_start` decision stage. Free text — empty string clears the
  // override and falls back to the workflow template's own default
  // instruction. Lives in workspace settings KV under
  // `auto_code.intake_instruction.<folderId>`.
  intakeInstruction: z.string().max(4_000).optional(),
  // Per-folder auto-merge toggle. When on, the orchestrator's
  // done-state hook fires `mergeWorktreeIntoTarget` automatically
  // so the user doesn't have to click "Merge into main" in the
  // drawer. Off by default — manual merge is the safe baseline.
  // Lives in workspace settings KV under
  // `auto_code.auto_merge.<folderId>` (`'1'` / `'0'` string).
  autoMergeEnabled: z.boolean().optional(),
  // Mo Indexing — per-folder generic-terms blocklist (free-text). The
  // Tier 1 prompt inlines it verbatim; empty string clears it.
  topicExclusions: z.string().max(10_000).optional(),
});

export const workflowCreateSchema = z.object({
  folderId: z.string().min(1),
  name: z.string().min(1).max(120),
  definition: WorkflowDefinitionSchema,
  isDefault: z.boolean().optional(),
});

export const workflowUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  definition: WorkflowDefinitionSchema.optional(),
  isDefault: z.boolean().optional(),
});

export const createSessionSchema = z.object({
  folderId: z.string().nullable().optional(),
  title: z.string().max(120).optional(),
});

export const sessionPatchSchema = z.object({
  title: z.string().max(120).optional(),
  archived: z.boolean().optional(),
  needsHuman: z.boolean().optional(),
});

export const sendMessageSchema = z.object({
  content: z.string().min(1).max(50_000),
  /** Set when the user types a custom decision into a quick-action
   *  group ("Give different instruction"). UI passes the phantom
   *  `<group-key>:custom` id (e.g. `bundle:0:custom`) so the group
   *  collapses on the next refresh and isn't re-asked. */
  repliedActionId: z.string().min(1).max(200).optional(),
});
