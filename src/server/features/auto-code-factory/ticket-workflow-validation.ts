/**
 * Validation helpers for per-ticket Auto-code workflow assignment.
 *
 * Ticket 01KRWQPDKQ2RZMDBJZ5KN0B7YE — "Auto-code: make Coding
 * Workflow selectable, before execution".
 *
 * The HTTP `PATCH /api/notes/:id` route AND the MCP `notes_update`
 * tool both call into these helpers before letting a `workflowId`
 * patch through. Keeping the gates here avoids drift between the
 * two surfaces — a CLI agent and the web UI MUST see the same
 * error envelope for the same offending patch.
 */

import type Database from 'better-sqlite3';
import {
  getWorkflowTemplate,
} from '../../../core/auto-code/workflows/templates.js';
import { WorkflowsRepository } from '../../../core/auto-code/workflows/workflows-repository.js';
import { WorkflowRunsRepository } from '../../../core/auto-code/workflows/runs-repository.js';

export type TicketWorkflowAssignmentError =
  | { error: 'workflow_not_found'; workflowId: string }
  | { error: 'workflow_not_owned_by_folder'; workflowId: string; folderId: string }
  | { error: 'workflow_locked_during_run'; runId: string }
  | { error: 'ticket_folder_required' };

/**
 * Resolve `workflowId` to either a built-in template id or a
 * `workflows` row owned by `folderId`. Returns the value the caller
 * should persist (verbatim) on `notes.workflow_id`, or an error
 * envelope describing why the patch is rejected.
 *
 * `null` is always valid — it clears the override so the ticket
 * falls back to the folder default.
 */
export function validateTicketWorkflowAssignment(
  db: Database.Database,
  folderId: string | null,
  workflowId: string | null,
): { ok: true; workflowId: string | null } | { ok: false; error: TicketWorkflowAssignmentError } {
  if (workflowId === null) {
    return { ok: true, workflowId: null };
  }
  if (!folderId) {
    // Workflow assignment only makes sense for notes that live in
    // a folder — the resolver scopes ownership by folderId. Unfiled
    // notes can't run auto-code at all.
    return { ok: false, error: { error: 'ticket_folder_required' } };
  }
  // Built-in template wins (no DB lookup).
  if (getWorkflowTemplate(workflowId)) {
    return { ok: true, workflowId };
  }
  // Custom workflow — MUST be owned by the same folder. Cross-
  // folder pointers fail-fast here instead of silently falling back
  // at admission time.
  const wfRepo = new WorkflowsRepository(db);
  const row = wfRepo.getById(workflowId);
  if (!row) {
    return { ok: false, error: { error: 'workflow_not_found', workflowId } };
  }
  if (row.folderId !== folderId) {
    return {
      ok: false,
      error: {
        error: 'workflow_not_owned_by_folder',
        workflowId,
        folderId,
      },
    };
  }
  return { ok: true, workflowId };
}

/**
 * Block a `workflowId` patch when there is an active workflow run
 * for this ticket. Per the ticket spec — "Если тикет в авто-коде
 * прямо сейчас, то workflow менять нельзя. Можно только вывести в
 * backlog/notes и поменять". The user can still drag the card out
 * of `todo`/`doing` to cancel the run, then change the workflow.
 *
 * Returns `null` when the patch is allowed. Returns the
 * `workflow_locked_during_run` error envelope when blocked.
 */
export function checkActiveRunLock(
  db: Database.Database,
  folderId: string | null,
  ticketId: string,
): TicketWorkflowAssignmentError | null {
  if (!folderId) return null;
  const runsRepo = new WorkflowRunsRepository(db);
  const active = runsRepo.findActiveRunForTicket(folderId, ticketId);
  if (!active) return null;
  return { error: 'workflow_locked_during_run', runId: active.id };
}
