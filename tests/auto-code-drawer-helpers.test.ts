import { describe, it, expect } from 'vitest';
import type { AutoCodeQueueRow, AutoCodeQueueState } from '../src/web/src/lib/api';
import {
  STATE_BADGES,
  effectivePathForRow,
  renderSessionStatusDot,
  resumeCwdForRow,
  sessionDepKey,
  sessionEntryKey,
  sessionSelectorToApiArg,
  truncate,
  worktreeFilePath,
} from '../src/web/src/components/AutoCodeDrawer/helpers';
import type { DrawerSessionEntry } from '../src/web/src/components/AutoCodeDrawer/types';

const mkRow = (over: Partial<AutoCodeQueueRow> = {}): AutoCodeQueueRow => ({
  id: '01ROWXXXX',
  folderId: '01FOLDERXX',
  taskId: '01TASKXXXX',
  state: 'done' as AutoCodeQueueState,
  attempts: 1,
  reopenCount: 0,
  repoPath: '/Users/me/code/proj',
  worktreeName: 'auto-01ROWXXXX',
  fixSessionId: null,
  reviewSessionId: null,
  lastVerdict: null,
  lastError: null,
  activePid: null,
  sessionGroupId: null,
  claimedAt: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...(over as Partial<AutoCodeQueueRow>),
});

const mkSession = (over: Partial<DrawerSessionEntry> = {}): DrawerSessionEntry => ({
  stageId: 'fix',
  stageKind: 'cli_agent',
  agentName: 'claude',
  sessionId: 'sess-abc',
  status: 'running',
  attempt: 1,
  label: 'fix · claude',
  engine: 'workflow',
  rowId: '01STAGEROW',
  ...over,
});

describe('effectivePathForRow', () => {
  it('returns repoPath on done_merged', () => {
    expect(effectivePathForRow(mkRow({ state: 'done_merged' }))).toBe('/Users/me/code/proj');
  });

  it('returns .morion worktree path on done with a worktreeName', () => {
    expect(effectivePathForRow(mkRow({ state: 'done', worktreeName: 'auto-XYZ' }))).toBe(
      '/Users/me/code/proj/.morion/worktrees/auto-XYZ',
    );
  });

  it('returns null on done without a worktreeName', () => {
    expect(effectivePathForRow(mkRow({ state: 'done', worktreeName: null }))).toBeNull();
  });

  it('returns null for in-flight / non-terminal states', () => {
    const states: AutoCodeQueueState[] = [
      'pending',
      'fix_running',
      'fix_review',
      'review_running',
      'reopened',
      'failed',
      'cancelled',
      'paused_ask_user',
    ];
    for (const s of states) {
      expect(effectivePathForRow(mkRow({ state: s }))).toBeNull();
    }
  });
});

describe('STATE_BADGES', () => {
  it('has a label + className for every AutoCodeQueueState', () => {
    const states: AutoCodeQueueState[] = [
      'pending',
      'fix_running',
      'fix_review',
      'review_running',
      'reopened',
      'done',
      'done_merged',
      'failed',
      'cancelled',
      'paused_ask_user',
    ];
    for (const s of states) {
      expect(STATE_BADGES[s]).toBeDefined();
      expect(STATE_BADGES[s].label.length).toBeGreaterThan(0);
      expect(STATE_BADGES[s].className.length).toBeGreaterThan(0);
    }
  });

  it('failed state surfaces as "escalated"', () => {
    expect(STATE_BADGES.failed.label).toBe('escalated');
  });

  it('paused_ask_user surfaces the awaiting-reply copy', () => {
    expect(STATE_BADGES.paused_ask_user.label).toBe('awaiting your reply');
  });
});

describe('renderSessionStatusDot', () => {
  it.each([
    ['running', '◐'],
    ['done', '●'],
    ['failed', '⨯'],
    ['cancelled', '○'],
    ['pending', '⊙'],
  ])('maps %s to %s', (status, dot) => {
    expect(renderSessionStatusDot(status)).toBe(dot);
  });

  it('falls back to bullet for unknown status', () => {
    expect(renderSessionStatusDot('queued')).toBe('•');
    expect(renderSessionStatusDot('')).toBe('•');
  });
});

describe('sessionSelectorToApiArg', () => {
  it('returns "fix" literal for legacy fix stage', () => {
    expect(sessionSelectorToApiArg(mkSession({ engine: 'legacy', stageId: 'fix' }))).toBe('fix');
  });

  it('returns "review" literal for legacy review stage', () => {
    expect(sessionSelectorToApiArg(mkSession({ engine: 'legacy', stageId: 'review' }))).toBe(
      'review',
    );
  });

  it('falls back to "fix" for unknown legacy stageId', () => {
    expect(sessionSelectorToApiArg(mkSession({ engine: 'legacy', stageId: 'anything' }))).toBe(
      'fix',
    );
  });

  it('returns structured { stageId, stageRowId } for workflow with rowId', () => {
    expect(
      sessionSelectorToApiArg(
        mkSession({ engine: 'workflow', stageId: 'review', rowId: '01ROW' }),
      ),
    ).toEqual({ stageId: 'review', stageRowId: '01ROW' });
  });

  it('omits stageRowId when workflow entry has no rowId', () => {
    expect(
      sessionSelectorToApiArg(mkSession({ engine: 'workflow', stageId: 'fix', rowId: undefined })),
    ).toEqual({ stageId: 'fix' });
  });
});

describe('sessionDepKey + sessionEntryKey', () => {
  it('workflow entries with rowId use rowId-based keys', () => {
    const s = mkSession({ engine: 'workflow', rowId: '01STAGEROW', stageId: 'fix' });
    expect(sessionDepKey(s)).toBe('wf:01STAGEROW');
    expect(sessionEntryKey(s)).toBe('01STAGEROW');
  });

  it('workflow entries without rowId fall back to legacy:<stageId>', () => {
    const s = mkSession({ engine: 'workflow', rowId: undefined, stageId: 'review' });
    expect(sessionDepKey(s)).toBe('legacy:review');
    expect(sessionEntryKey(s)).toBe('legacy:review');
  });

  it('legacy entries always use legacy:<stageId> keys', () => {
    const s = mkSession({ engine: 'legacy', rowId: undefined, stageId: 'fix' });
    expect(sessionDepKey(s)).toBe('legacy:fix');
    expect(sessionEntryKey(s)).toBe('legacy:fix');
  });

  it('keys disambiguate two attempts of the same workflow stage', () => {
    const a = mkSession({ engine: 'workflow', stageId: 'fix', rowId: '01ROWA' });
    const b = mkSession({ engine: 'workflow', stageId: 'fix', rowId: '01ROWB' });
    expect(sessionEntryKey(a)).not.toBe(sessionEntryKey(b));
    expect(sessionDepKey(a)).not.toBe(sessionDepKey(b));
  });
});

describe('truncate', () => {
  it('returns input unchanged when below max', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns input unchanged at exact max length', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
  });

  it('truncates and appends remaining-char count', () => {
    expect(truncate('abcdefghij', 4)).toBe('abcd\n…[6 more chars]');
  });

  it('handles empty string', () => {
    expect(truncate('', 100)).toBe('');
  });
});

describe('resumeCwdForRow', () => {
  it('returns the .morion worktree path when worktreeName present', () => {
    expect(resumeCwdForRow(mkRow({ worktreeName: 'auto-XYZ' }))).toBe(
      '/Users/me/code/proj/.morion/worktrees/auto-XYZ',
    );
  });

  it('falls back to repoPath when no worktree was provisioned', () => {
    expect(resumeCwdForRow(mkRow({ worktreeName: null }))).toBe('/Users/me/code/proj');
  });
});

describe('worktreeFilePath', () => {
  it('joins repoPath + .morion/worktrees/<wt>/<path> when worktree present', () => {
    expect(worktreeFilePath('/repo', 'wt-1', 'src/foo.ts')).toBe(
      '/repo/.morion/worktrees/wt-1/src/foo.ts',
    );
  });

  it('falls back to repoPath + path when no worktree', () => {
    expect(worktreeFilePath('/repo', null, 'src/foo.ts')).toBe('/repo/src/foo.ts');
  });
});
