/**
 * Regression: Folder Settings → Auto-code tab → "+ New workflow"
 * button was a no-op for creation. It called
 * `onOpenWorkflowsPopup(null)`, which opened the popup falling back
 * to the folder's active workflow — so the user saw the default
 * workflow they already had, not a "new" one.
 *
 * Fix: the button now calls `api.createAutoCodeWorkflow` with
 * EMPTY_DEFINITION first, then opens the popup focused on the
 * created row's id. Mirrors the sidebar's "+ New" action in
 * AutoCodePopup. The Edit button (`onOpenWorkflowsPopup(w.id)`) was
 * already correct and stays untouched.
 *
 * This test is a static content pin: it verifies the source no
 * longer ships the old wiring (the literal `onOpenWorkflowsPopup?.(null)`
 * call on the "+ New" button) AND that the new flow is present
 * (api.createAutoCodeWorkflow + EMPTY_DEFINITION import). Cheap,
 * deterministic, fails the moment someone reverts.
 *
 * Ticket: 01KRYBVTKJ56A6KE93Y09VXG4E
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..');
const SRC = readFileSync(
  join(REPO, 'src/web/src/components/folder-settings/auto-code/FolderWorkflowsSection.tsx'),
  'utf8',
);

describe('FolderWorkflowsSection "+ New workflow" wiring (01KRYBVTKJ56A6KE93Y09VXG4E)', () => {
  it('the "+ New workflow" header button is NOT wired to onOpenWorkflowsPopup(null)', () => {
    // Old broken pattern: opening the popup with a null preselect,
    // which falls back to the folder's active workflow rather than
    // creating a new one.
    expect(SRC).not.toMatch(/onClick=\{\(\)\s*=>\s*onOpenWorkflowsPopup\?\.\(null\)\}/);
  });

  it('imports EMPTY_DEFINITION from the AutoCodePopup helper', () => {
    expect(SRC).toMatch(
      /import\s*\{\s*EMPTY_DEFINITION\s*\}\s*from\s*['"]\.\.\/\.\.\/auto-code-popup\/empty-definition['"]/,
    );
  });

  it('creates a workflow via api.createAutoCodeWorkflow with EMPTY_DEFINITION before opening', () => {
    expect(SRC).toMatch(/api\.createAutoCodeWorkflow\(/);
    expect(SRC).toMatch(/definition:\s*EMPTY_DEFINITION/);
  });

  it('opens the popup focused on the freshly-created row id', () => {
    // After the create resolves, the handler must hand the created
    // workflow's id to onOpenWorkflowsPopup so the popup lands on
    // that row (not the folder's default active).
    expect(SRC).toMatch(/onOpenWorkflowsPopup\?\.\(created\.id\)/);
  });

  it('Edit row button still passes the row id (via WorkflowRow onEdit prop)', () => {
    // Edit was always correct; this pins the contract so a future
    // refactor doesn't accidentally break it. After ticket #3 the
    // Edit button lives inside WorkflowRow — the row's onEdit prop
    // is the wiring point now.
    expect(SRC).toMatch(/onEdit=\{\(\)\s*=>\s*onOpenWorkflowsPopup\?\.\(w\.id\)\}/);
  });
});
