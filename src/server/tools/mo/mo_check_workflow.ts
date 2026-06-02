import { z } from 'zod';
import { defineTool } from '../types.js';
import { canPerform, type Action, type Target } from '../../../core/permissions/check.js';
import { requireMoEnabledForFolder } from './gate.js';

/**
 * Phase 4 (deterministic part) — `mo_check_workflow`.
 *
 * Pre-flight check the agent runs before doing something with real
 * blast radius. Returns one of three decisions:
 *
 *   - `allow`    — go ahead. Folder perms pass + the action is in
 *                   the safe-by-default category for this folder.
 *   - `deny`     — folder MCP perms explicitly forbid the action.
 *                   Agent MUST NOT proceed. Surface the reason to
 *                   the user.
 *   - `ask_user` — the gate is open in principle but the action is
 *                   either destructive or mass-scoped enough that
 *                   the human should sign off. Agent should pause
 *                   and ask in chat (or, once the chat-loop tools
 *                   land, route through `mo_request_human`).
 *
 * Phase 4 deterministic intentionally does NOT try to interpret the
 * folder's free-text `workflow` field — that's LLM territory and
 * lands with the LLM-tier slice of Phase 4. Instead the workflow text
 * is RETURNED VERBATIM in the response so the agent (which is itself
 * an LLM) can read the policy and apply judgment on top of the
 * deterministic baseline. Single source of truth for the policy:
 * `concierge_folder_settings.workflow`.
 *
 * Default decision matrix (after the deny path is ruled out):
 *
 *   create    → allow      (low blast radius, reversible via trash)
 *   update    → allow      (reversible via revisions)
 *   archive   → allow      (reversible via unarchive)
 *   move      → allow      (metadata only, fully reversible)
 *   delete    → ask_user   (soft-delete is reversible but uncommon)
 *   targetIds.length > 5 → ask_user regardless of action
 *                          (mass operations always escalate)
 */

const INTENDED_ACTIONS = ['create', 'update', 'archive', 'move', 'delete'] as const;
const TARGET_KINDS = ['note', 'tag', 'folder', 'kanban_card'] as const;
const MASS_OPERATION_THRESHOLD = 5;

export interface WorkflowDecision {
  ok: true;
  decision: 'allow' | 'deny' | 'ask_user';
  reason: string;
  /** The per-folder workflow text VERBATIM. Null when no policy
   * configured. Agent reads this on top of `decision` to apply
   * project-specific judgment. */
  workflow: string | null;
  /** Resolved folder MCP permissions for the caller. Lets the agent
   * understand WHY a deny fired without re-querying. */
  permissions: {
    read: boolean;
    create: boolean;
    update: boolean;
    delete: boolean;
  };
  /** When `decision === 'ask_user'`, the structured reason category
   * the agent / UI can branch on without re-parsing `reason`. */
  escalation?: 'destructive_action' | 'mass_operation';
}

/** Map the agent-facing `intendedAction` to the canPerform Action.
 * archive/move are metadata-only mutations on existing rows, so
 * they require `update`. */
function intendedToPermAction(intended: typeof INTENDED_ACTIONS[number]): Action {
  switch (intended) {
    case 'create':
      return 'create';
    case 'update':
    case 'archive':
    case 'move':
      return 'update';
    case 'delete':
      return 'delete';
  }
}

export const moCheckWorkflowTool = defineTool({
  name: 'mo_check_workflow',
  category: 'read',
  description:
    "Pre-flight check before a real-blast-radius action. Returns `decision: 'allow' | 'deny' | 'ask_user'` plus the folder's per-folder workflow text VERBATIM so the agent can layer project-specific judgment on top of the deterministic baseline. Requires the folder to have Mo enabled. Use BEFORE the destructive op, not after.",
  inputShape: {
    folderId: z
      .string()
      .min(1)
      .describe('Required folder id the action targets.'),
    intendedAction: z
      .enum(INTENDED_ACTIONS)
      .describe(
        'What you are about to do. `archive` and `move` are treated as `update` for permission purposes (metadata-only).',
      ),
    targetKind: z
      .enum(TARGET_KINDS)
      .optional()
      .describe(
        "What you're acting on. Defaults to `note`. Use `folder` only when the action targets the folder itself (delete folder, archive folder).",
      ),
    summary: z
      .string()
      .min(1)
      .describe(
        'One-line human-readable description of the operation, used in the response `reason` so the user understands what is being asked about.',
      ),
    targetIds: z
      .array(z.string().min(1))
      .optional()
      .describe(
        `Optional list of ids the operation affects. When length > ${MASS_OPERATION_THRESHOLD} the decision auto-escalates to ask_user as a mass operation.`,
      ),
  },
  async handler(input, ctx): Promise<WorkflowDecision | { error: string; reason?: string; message?: string }> {

    const moGate = requireMoEnabledForFolder(ctx, input.folderId);
    if (moGate) return moGate;

    const folder = ctx.folders.getById(input.folderId);
    if (!folder) {
      return {
        error: 'folder_not_found',
        message: `No folder with id ${input.folderId}.`,
      };
    }

    const targetKind = input.targetKind ?? 'note';

    // Resolve the canPerform Target for the deny check. Folder-level
    // actions probe folder perms; everything else probes folder-level
    // create perms (the agent doesn't have a concrete note id at
    // pre-flight time, so we approximate via the folder's create gate
    // for `create`, and update/delete gates for the rest).
    const permAction = intendedToPermAction(input.intendedAction);
    let probeTarget: Target;
    if (targetKind === 'folder') {
      probeTarget = { kind: 'folder', folderId: input.folderId };
    } else if (input.intendedAction === 'create') {
      probeTarget = { kind: 'newNote', folderId: input.folderId };
    } else {
      // For update/archive/move/delete on a note, probe the folder's
      // capability for that action. (We can't probe a specific note's
      // overrides without a note id, but the folder gate is the floor:
      // if the folder denies, all notes inside deny too.)
      probeTarget = { kind: 'folder', folderId: input.folderId };
    }

    const allowed = canPerform(permAction, ctx, probeTarget);

    // Phase 6.7 v2 follow-up (2026-04-28): the per-folder workflow
    // text surface was retired — Mo no longer threads house-style
    // policy through tool calls. Field stays in the response shape
    // (always null) so existing agents that branch on it keep
    // working; the gate now relies purely on perms + blast-radius.
    const workflow: string | null = null;

    const permissions = {
      read: folder.mcpPermissions.visible,
      create: folder.mcpPermissions.visible && folder.mcpPermissions.create,
      update: folder.mcpPermissions.visible && folder.mcpPermissions.update,
      delete: folder.mcpPermissions.visible && folder.mcpPermissions.delete,
    };

    if (!allowed) {
      return {
        ok: true,
        decision: 'deny',
        reason: `Folder MCP perms forbid \`${input.intendedAction}\` on ${targetKind}s in folder "${folder.name}". The user can change this in folder settings → AI Access. Operation: ${input.summary}`,
        workflow,
        permissions,
      };
    }

    // Mass-operation escalation: regardless of action category, more
    // than N affected items always asks the human.
    const targetCount = input.targetIds?.length ?? 0;
    if (targetCount > MASS_OPERATION_THRESHOLD) {
      return {
        ok: true,
        decision: 'ask_user',
        reason: `Operation affects ${targetCount} items (over the ${MASS_OPERATION_THRESHOLD}-item mass-operation threshold). Pause and ask the user to confirm before proceeding. Operation: ${input.summary}`,
        workflow,
        permissions,
        escalation: 'mass_operation',
      };
    }

    // Destructive action escalation: deletes ask the user. Other
    // mutations are reversible enough to allow by default.
    if (input.intendedAction === 'delete') {
      return {
        ok: true,
        decision: 'ask_user',
        reason: `Delete is destructive (soft-deletes survive 7 days in trash, then purge). Pause and ask the user to confirm. Operation: ${input.summary}`,
        workflow,
        permissions,
        escalation: 'destructive_action',
      };
    }

    return {
      ok: true,
      decision: 'allow',
      reason: `\`${input.intendedAction}\` on ${targetCount > 0 ? `${targetCount} ${targetKind}(s)` : `a ${targetKind}`} in folder "${folder.name}" is within default policy. Operation: ${input.summary}`,
      workflow,
      permissions,
    };
  },
});
