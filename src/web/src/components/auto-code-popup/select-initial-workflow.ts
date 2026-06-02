import type { AutoCodeWorkflowSummary } from '../../lib/api';

/**
 * Pure helpers for choosing which workflow row the AutoCode popup
 * highlights on open + which row the sidebar marks as "default" for
 * the folder.
 *
 *  - `resolveInitialWorkflowId(preselected, storedActiveId, workflows)`
 *    picks the row to focus on first open: an explicit `preselected`
 *    caller id wins (if it still exists in the list), then the folder's
 *    stored active id, then the row marked `isDefault`, then the first
 *    row.
 *  - `resolveActiveWorkflowId(storedActiveId, workflows)` — same chain
 *    minus the caller-preselected layer; used by the sidebar to keep
 *    the "default" pill in sync with the dropdown in FolderSettings.
 *
 * Splitting these out makes the popup's once-only resolution logic
 * testable without spinning up the React tree.
 */

export function resolveActiveWorkflowId(
  storedActiveId: string,
  workflows: ReadonlyArray<AutoCodeWorkflowSummary>,
): string {
  const matched = workflows.find((w) => w.id === storedActiveId);
  const fallback =
    workflows.find((w) => w.isDefault) ?? workflows[0] ?? null;
  return matched?.id ?? fallback?.id ?? '';
}

export function resolveInitialWorkflowId(
  preselected: string | null,
  storedActiveId: string,
  workflows: ReadonlyArray<AutoCodeWorkflowSummary>,
): string | null {
  // Caller-preselected id wins when still present in the list — the
  // popup-open flow from FolderSettings's "Edit" button passes a
  // specific row, and we should not bounce off it onto the active
  // workflow just because the caller's choice differs.
  if (preselected) {
    return workflows.some((w) => w.id === preselected) ? preselected : null;
  }
  const matched = workflows.find((w) => w.id === storedActiveId);
  const fallback =
    workflows.find((w) => w.isDefault) ?? workflows[0] ?? null;
  const pick = matched ?? fallback;
  return pick ? pick.id : null;
}
