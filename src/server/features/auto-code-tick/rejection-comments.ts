import type { UnifiedEnqueueResult } from '../auto-code-factory/index.js';
import type { AutoCodeTickDeps } from './internals.js';

/**
 * Rejection-comment helpers shared by both ticks. Posts a visible
 * mcp:auto-code comment on the ticket when the dispatcher rejects
 * for a user-actionable reason, with a 24h dedup gate so the comment
 * thread doesn't drown in repeats.
 *
 * Extracted from auto-code-tick.ts during the 2026-05-16 split
 * (Morion ticket 01KRQYVA7GSM8W77J94JB2P615).
 */

/** Marker prefix for rejection comments — used by `maybePostRejectionComment`
 *  to detect "did I already post a rejection for this reason recently?".
 *  Stable string so the dedup gate keeps working across UI copy tweaks
 *  (translate the suffix only, keep the prefix). */
export const REJECTION_COMMENT_PREFIX = '⚠️ Auto-code can\'t run this ticket';

/** Re-post the same rejection comment no more often than this. Prevents
 *  comment-flood when the audit tick re-audits a still-stuck ticket on
 *  every poll. 24h is generous — the user gets one alert per day if
 *  they don't fix the underlying issue. */
export const REJECTION_COMMENT_DEDUP_MS = 24 * 60 * 60 * 1000;

/**
 * Map an enqueue rejection envelope to a human-readable comment body.
 * Returns null when the rejection is a benign / expected case that
 * shouldn't surface to the user (`folder_cap_exceeded`, `already_running`,
 * etc. — those are "we're already on it" signals, not failures).
 *
 * Reason values surveyed across `WorkflowOrchestrator.enqueueTicket` +
 * `AutoCodeOrchestrator.enqueueTask` + factory soft-rejects:
 *
 *   - `workflow_not_runnable`  → user-visible (workflow has unsupported stages)
 *   - `agent_unavailable`      → user-visible (CLI not installed)
 *   - `auto_code_unavailable`  → user-visible (Mo/claude not wired)
 *   - `budget_exhausted`       → user-visible (cap hit)
 *   - `linked_repo_missing`    → user-visible (no repo path set)
 *   - `auto_code_disabled`     → SILENT (folder toggle is off — expected)
 *   - `mo_disabled`            → SILENT (Mo toggle is off — expected)
 *   - `folder_cap_exceeded`    → SILENT (concurrency cap; another run will pick up)
 *   - `already_running`        → SILENT (deduped; another run is active)
 *   - `note_not_in_folder`     → SILENT (race condition; ticket moved out)
 */
export function buildRejectionCommentBody(
  reason: string,
  missingDetails?: readonly string[],
): string | null {
  const detailLine =
    missingDetails && missingDetails.length > 0
      ? `\n\n${missingDetails.map((d) => `  • ${d}`).join('\n')}`
      : '';
  switch (reason) {
    case 'workflow_not_runnable':
      return `${REJECTION_COMMENT_PREFIX} — the selected workflow contains a stage kind the runner can't execute yet (likely \`human_gate\`, which is Phase 5 work).${detailLine}\n\nTo recover: open the workflow in the editor and remove the unsupported stage, OR pick a different default workflow for this folder in Folder Settings → Auto-code.`;
    case 'agent_unavailable':
      return `${REJECTION_COMMENT_PREFIX} — the workflow needs a CLI agent that isn't installed on this machine.${detailLine}\n\nTo recover: install the missing agent (\`npm i -g @openai/codex\`, \`brew install --cask claude\`, etc.) OR switch the folder's workflow template to one that uses an available agent.`;
    case 'auto_code_unavailable':
      return `${REJECTION_COMMENT_PREFIX} — the auto-code engine isn't wired in this process.${detailLine}\n\nTo recover: verify Mo is configured (Settings → Ask Mo) and the \`claude\` CLI is detected, then drag the ticket out of \`todo\` and back in to retrigger.`;
    case 'budget_exhausted':
      return `${REJECTION_COMMENT_PREFIX} — the auto-code monthly budget is exhausted.${detailLine}\n\nTo recover: raise the cap in Settings → Auto-code, OR wait for the monthly reset.`;
    case 'linked_repo_missing':
      return `${REJECTION_COMMENT_PREFIX} — the folder has no linked git repo path.${detailLine}\n\nTo recover: open Folder Settings → Auto-code and set the **Linked repo path**.`;
    // Benign / self-resolving — don't spam the ticket.
    case 'auto_code_disabled':
    case 'mo_disabled':
    case 'folder_cap_exceeded':
    case 'already_running':
    case 'note_not_in_folder':
    case 'preflight_ineligible':
      return null;
    default:
      // Unknown reason — surface verbatim so a future code path adding
      // a new rejection doesn't go invisible. Future maintainer should
      // add an explicit case for any new reason they introduce.
      return `${REJECTION_COMMENT_PREFIX} — \`${reason}\`.${detailLine}\n\nThis is an uncommon rejection reason — open the auto-code drawer for details, or report it.`;
  }
}

/**
 * Post a rejection comment on the ticket from `mcp:auto-code` actor,
 * unless a comment with the SAME prefix was posted within the dedup
 * window (default 24h). The dedup gate uses `comments.list` (DESC by
 * created_at) and inspects the first matching mcp:auto-code row — a
 * recent rejection comment from any reason suppresses re-posting, on
 * the theory that the user has already been alerted and is dealing
 * with it. This trades "user sees every reason exactly once per day"
 * for "ticket comment thread doesn't drown in repeated alerts".
 *
 * Failure modes (all swallowed — best effort, never break the tick):
 *   - comments repo not wired (test path).
 *   - comments.list throws (DB locked, etc.).
 *   - comments.create throws (permission gate, etc.).
 */
export function maybePostRejectionComment(
  deps: AutoCodeTickDeps,
  noteId: string,
  result: Extract<UnifiedEnqueueResult, { kind: 'rejected' }>,
  now: number,
): void {
  if (!deps.comments) return;
  const body = buildRejectionCommentBody(result.reason, result.missingDetails);
  if (body === null) return; // benign rejection — silent on purpose
  // Dedup: scan the most recent 10 comments for a recent mcp:auto-code
  // rejection comment. 10 is enough to look past intervening user /
  // Mo intake comments in a chatty ticket.
  try {
    const recent = deps.comments.list(noteId, { limit: 10 });
    for (const c of recent.items) {
      if (c.actor !== 'mcp:auto-code') continue;
      if (!c.body.startsWith(REJECTION_COMMENT_PREFIX)) continue;
      if (now - c.createdAt < REJECTION_COMMENT_DEDUP_MS) {
        return; // recent dup — skip
      }
      break; // older dup — fall through and post fresh
    }
  } catch {
    // list failed — proceed to post anyway. Worst case: occasional
    // duplicate comment, never a missed alert.
  }
  try {
    deps.comments.create(noteId, body, 'mcp:auto-code', null);
  } catch {
    // best-effort
  }
}
