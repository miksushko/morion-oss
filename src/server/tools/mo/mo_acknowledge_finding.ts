import { z } from 'zod';
import { defineTool } from '../types.js';
import { canPerform, ACCESS_DENIED } from '../../../core/permissions/check.js';
import {
  requireMoEnabledForFolder,
  MO_INTERNAL_NOT_WIRED,
} from './gate.js';

/**
 * Mo Indexing Redesign Phase 5d — `mo_acknowledge_finding` MCP tool.
 *
 * Lifecycle action on a Tier 0 deterministic finding written to
 * `mo_patrol_findings`. Three actions:
 *
 *   accept    — user confirmed the finding, will act on it
 *               (out-of-band). Row stays for audit but won't show up
 *               in "open findings" views.
 *   dismiss   — user / agent rejects this finding. The row is
 *               recorded as dismissed; future patrol passes can dedup
 *               via `findingsRepo.hasOpenSimilar()` to avoid
 *               re-surfacing the same finding kind on the same note.
 *   snooze    — temporarily hide until `snoozeUntilTs` (ms-epoch). On
 *               read after that timestamp, the row implicitly flips
 *               back to 'open' via the `listOpen` query.
 *
 * Mo-enabled-folder + per-folder MCP update perm gates.
 */
export const moAcknowledgeFindingTool = defineTool({
  name: 'mo_acknowledge_finding',
  category: 'update',
  description:
    "Mark a Tier 0 patrol finding (in mo_patrol_findings) as accepted, dismissed, or snoozed. accept = user will act on it; dismiss = reject this finding (future patrols can dedup); snooze = hide until snoozeUntilTs. Pro + Mo-enabled folder.",
  inputShape: {
    findingId: z
      .string()
      .min(1)
      .describe(
        'The patrol finding id (a ULID stored in mo_patrol_findings.id). Look it up via the `mo:patrol-log` markdown note or via a future findings-list MCP read tool.',
      ),
    action: z
      .enum(['accept', 'dismiss', 'snooze'])
      .describe(
        'Lifecycle transition. accept (audit-trail done), dismiss (suppress future re-detection), snooze (temporary hide).',
      ),
    snoozeUntilTs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Wall-clock ms-epoch when a snooze should expire. Required when action=snooze. After this timestamp the row implicitly returns to "open" on read.',
      ),
  },
  async handler(input, ctx) {

    if (!ctx.concierge || !ctx.concierge.moPatrolFindings) {
      return MO_INTERNAL_NOT_WIRED;
    }

    if (input.action === 'snooze' && input.snoozeUntilTs === undefined) {
      return {
        error: 'mo_invalid_input',
        reason: 'snooze_requires_timestamp',
        message:
          'action=snooze requires snoozeUntilTs (ms-epoch). To dismiss permanently, pass action=dismiss instead.',
      };
    }

    const finding = ctx.concierge.moPatrolFindings.get(input.findingId);
    if (!finding) {
      return {
        error: 'finding_not_found',
        message: `Finding ${input.findingId} not found.`,
      };
    }

    const moGate = requireMoEnabledForFolder(ctx, finding.folderId);
    if (moGate) return moGate;

    if (
      !canPerform('update', ctx, {
        kind: 'folder',
        folderId: finding.folderId,
      })
    ) {
      return ACCESS_DENIED;
    }

    const ok = ctx.concierge.moPatrolFindings.setState(
      input.findingId,
      input.action,
      {
        snoozeUntil: input.snoozeUntilTs,
      },
    );
    if (!ok) {
      return {
        error: 'finding_not_found',
        message: 'Finding disappeared between read and write — race?',
      };
    }

    const refreshed = ctx.concierge.moPatrolFindings.get(input.findingId);
    return {
      findingId: input.findingId,
      action: input.action,
      state: refreshed?.state,
      snoozeUntil: refreshed?.snoozeUntil,
      stateChangedAt: refreshed?.stateChangedAt,
    };
  },
});
