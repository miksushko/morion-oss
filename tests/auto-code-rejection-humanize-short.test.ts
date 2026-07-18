import { describe, it, expect } from 'vitest';
import { humanizeAutoCodeRejectionShort } from '../src/server/features/auto-code-tick/rejection-comments.js';

/**
 * Surface an explicit reason when a
 * kanban drag into `todo` can't start auto-code, instead of the ticket
 * silently sitting there. This pins the concise (toast-length) humanizer.
 */
describe('humanizeAutoCodeRejectionShort', () => {
  it('explains the linked-repo-missing case and folds in the path detail', () => {
    const msg = humanizeAutoCodeRejectionShort('linked_repo_missing', [
      'linked repo path does not exist on disk: /Users/me/Projects/test_tetris',
    ]);
    expect(msg).toContain("Auto-code can't run");
    expect(msg).toContain('/Users/me/Projects/test_tetris');
    expect(msg).toContain('Folder Settings');
  });

  it('covers the other user-actionable reasons with a non-empty one-liner', () => {
    for (const reason of [
      'agent_unavailable',
      'auto_code_unavailable',
      'workflow_not_runnable',
      'budget_exhausted',
      'preflight_blocked',
      'mo_disabled',
    ]) {
      const msg = humanizeAutoCodeRejectionShort(reason);
      expect(msg, reason).toBeTruthy();
      expect(msg!.startsWith("Auto-code can't run")).toBe(true);
      // Single line — it's a toast, not a comment.
      expect(msg).not.toContain('\n');
    }
  });

  it('stays silent (null) for benign / self-resolving reasons', () => {
    for (const reason of [
      'auto_code_disabled',
      'folder_cap_exceeded',
      'already_running',
      'note_not_in_folder',
      'preflight_ineligible',
    ]) {
      expect(humanizeAutoCodeRejectionShort(reason), reason).toBeNull();
    }
  });

  it('surfaces an unknown reason verbatim rather than swallowing it', () => {
    const msg = humanizeAutoCodeRejectionShort('some_new_reason');
    expect(msg).toContain('some_new_reason');
  });
});
