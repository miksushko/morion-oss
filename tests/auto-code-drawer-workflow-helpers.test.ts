import { describe, it, expect } from 'vitest';
import type { AutoCodeQueueRow, AutoCodeQueueState } from '../src/web/src/lib/api';
import { isLockedDuringRun } from '../src/web/src/components/AutoCodeDrawer/WorkflowAssignmentSection';

/**
 * Per-ticket workflow dropdown lock helper — ticket
 * 01KRWQPDKQ2RZMDBJZ5KN0B7YE. Mid-flight runs MUST keep the dropdown
 * disabled so the user can't swap workflows under a runner that
 * already loaded an immutable graph snapshot. Terminal states are
 * unlocked — the user can pin a new workflow ahead of the next run.
 */

function row(state: AutoCodeQueueState): AutoCodeQueueRow {
  return {
    id: 'r1',
    folderId: 'f1',
    taskId: 't1',
    state,
    attempts: 0,
    reopenCount: 0,
    repoPath: '/r',
    worktreeName: null,
    fixSessionId: null,
    reviewSessionId: null,
    lastVerdict: null,
    lastError: null,
    activePid: null,
    sessionGroupId: null,
    claimedAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('isLockedDuringRun', () => {
  it('empty runs list is unlocked', () => {
    expect(isLockedDuringRun([])).toBe(false);
  });

  for (const s of [
    'pending',
    'fix_running',
    'fix_review',
    'review_running',
    'paused_ask_user',
  ] as const) {
    it(`locked when at least one run is in ${s}`, () => {
      expect(isLockedDuringRun([row(s)])).toBe(true);
    });
  }

  for (const s of ['done', 'done_merged', 'failed', 'cancelled', 'reopened'] as const) {
    it(`unlocked when every run is terminal (${s})`, () => {
      expect(isLockedDuringRun([row(s)])).toBe(false);
    });
  }

  it('mixed runs are locked when ANY is active', () => {
    expect(isLockedDuringRun([row('done'), row('fix_running'), row('cancelled')])).toBe(
      true,
    );
  });
});
