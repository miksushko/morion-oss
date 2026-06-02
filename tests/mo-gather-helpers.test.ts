import { describe, it, expect } from 'vitest';
import { truncate } from '../src/core/concierge/context/gather/helpers.ts';
import { validateInput } from '../src/core/concierge/context/gather/validate.ts';
import {
  emptyPacket,
  rehydrateCachedPacket,
  renderFallbackPacket,
  synthesisSkippedPacket,
} from '../src/core/concierge/context/gather/fallback-packets.ts';
import type { BootstrapState } from '../src/core/concierge/context/gather/bootstrap-state.ts';
import type { WorkContextPacket } from '../src/core/concierge/context/types.ts';

const mkBootstrap = (over: Partial<BootstrapState> = {}): BootstrapState => ({
  taskId: '01TASKXXX',
  folderId: '01FOLDERX',
  taskBodyHash: 'h',
  folderCatalogHash: 'c',
  clusterIds: [],
  taskBody: 'body',
  taskTitle: 'A task',
  metadataSummary: null,
  metadataKeywords: [],
  comments: [],
  audit: [],
  ...over,
});

describe('truncate', () => {
  it('returns input unchanged when within max', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns input unchanged at exact max', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
  });

  it('truncates and appends an ellipsis', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcde…');
  });

  it('handles empty string', () => {
    expect(truncate('', 100)).toBe('');
  });

  it('handles max=0', () => {
    expect(truncate('a', 0)).toBe('…');
  });
});

describe('validateInput', () => {
  it('passes with taskId only', () => {
    expect(() => validateInput({ taskId: 'a' })).not.toThrow();
  });

  it('passes with question only', () => {
    expect(() => validateInput({ question: 'why?' })).not.toThrow();
  });

  it('rejects when both supplied', () => {
    expect(() => validateInput({ taskId: 'a', question: 'why?' })).toThrow(
      /exactly one of/,
    );
  });

  it('rejects when neither supplied', () => {
    expect(() => validateInput({})).toThrow(/exactly one of/);
  });

  it('rejects when both are empty strings', () => {
    // hasTask = !!'' = false, hasQuestion = !!'' = false — same as neither
    expect(() => validateInput({ taskId: '', question: '' })).toThrow(
      /exactly one of/,
    );
  });
});

describe('renderFallbackPacket', () => {
  it('surfaces the task title + id', () => {
    const out = renderFallbackPacket(mkBootstrap({ taskTitle: 'Fix bug' }));
    expect(out).toContain('Task: Fix bug (01TASKXXX)');
  });

  it('includes the metadata summary when present', () => {
    const out = renderFallbackPacket(
      mkBootstrap({ metadataSummary: 'Mo summary line' }),
    );
    expect(out).toContain('Summary: Mo summary line');
  });

  it('omits the Summary line when no summary', () => {
    const out = renderFallbackPacket(mkBootstrap({ metadataSummary: null }));
    expect(out).not.toContain('Summary:');
  });

  it('lists cluster ids when present', () => {
    const out = renderFallbackPacket(
      mkBootstrap({ clusterIds: ['c1', 'c2'] }),
    );
    expect(out).toContain('Clusters: c1, c2');
  });

  it('falls back to (untitled) when title is null', () => {
    const out = renderFallbackPacket(mkBootstrap({ taskTitle: null }));
    expect(out).toContain('(untitled)');
  });

  it('skips the task block entirely when taskId is null', () => {
    const out = renderFallbackPacket(mkBootstrap({ taskId: null }));
    expect(out).not.toContain('Task:');
    expect(out).toContain('Synthesis step failed');
  });
});

describe('emptyPacket', () => {
  it('returns zeroes and propagates capped + warnings', () => {
    const p = emptyPacket({
      mode: 'full',
      scope: 'folder',
      capped: 'budget_exhausted',
      warnings: ['no headroom'],
    });
    expect(p).toEqual({
      mode: 'full',
      scope: 'folder',
      bootstrap: {
        taskId: null,
        folderId: null,
        clusterIds: [],
        commentCount: 0,
        auditCount: 0,
      },
      synthesizedMarkdown: '',
      citedNoteIds: [],
      risks: [],
      cacheHit: null,
      spentUsd: 0,
      capped: 'budget_exhausted',
      warnings: ['no headroom'],
    });
  });

  it('accepts workspace scope', () => {
    const p = emptyPacket({
      mode: 'brief',
      scope: 'workspace',
      capped: null,
      warnings: [],
    });
    expect(p.scope).toBe('workspace');
  });
});

describe('synthesisSkippedPacket', () => {
  it('renders bootstrap shape + uses fallback markdown', () => {
    const bootstrap = mkBootstrap({
      taskTitle: 'X',
      comments: [
        { actor: 'user', body: 'a', createdAt: 1 },
        { actor: 'user', body: 'b', createdAt: 2 },
      ],
      audit: [
        { action: 'created', actor: 'user', ts: 1 },
      ],
    });
    const p = synthesisSkippedPacket({
      mode: 'full',
      scope: 'folder',
      bootstrap,
      warnings: ['wave_cap'],
      capped: 'wave_cap',
      spentUsd: 0.12,
    });
    expect(p.bootstrap.taskId).toBe('01TASKXXX');
    expect(p.bootstrap.commentCount).toBe(2);
    expect(p.bootstrap.auditCount).toBe(1);
    expect(p.synthesizedMarkdown).toContain('Mo context (synthesis unavailable)');
    expect(p.synthesizedMarkdown).toContain('Task: X');
    expect(p.spentUsd).toBe(0.12);
    expect(p.capped).toBe('wave_cap');
    expect(p.warnings).toEqual(['wave_cap']);
  });

  it('citedNoteIds + risks are empty (no synth ran)', () => {
    const p = synthesisSkippedPacket({
      mode: 'full',
      scope: 'folder',
      bootstrap: mkBootstrap(),
      warnings: [],
      capped: 'budget_exhausted',
      spentUsd: 0,
    });
    expect(p.citedNoteIds).toEqual([]);
    expect(p.risks).toEqual([]);
  });
});

describe('rehydrateCachedPacket', () => {
  const mkSerialized = (over: Partial<WorkContextPacket> = {}): string => {
    const base: WorkContextPacket = {
      mode: 'full',
      scope: 'folder',
      bootstrap: {
        taskId: '01TASKXXX',
        folderId: '01FOLDERX',
        clusterIds: ['c1'],
        commentCount: 3,
        auditCount: 1,
      },
      synthesizedMarkdown: '# Cached body',
      citedNoteIds: ['01N1', '01N2'],
      risks: ['risk-1'],
      cacheHit: null,
      spentUsd: 0.42,
      capped: null,
      warnings: [],
      ...over,
    };
    return JSON.stringify(base);
  };

  it('parses valid JSON and overlays the per-call overrides', () => {
    const out = rehydrateCachedPacket(mkSerialized(), {
      mode: 'brief',
      scope: 'workspace',
      cacheHit: { kind: 'exact' },
    });
    expect(out.mode).toBe('brief');
    expect(out.scope).toBe('workspace');
    expect(out.cacheHit).toEqual({ kind: 'exact' });
    expect(out.synthesizedMarkdown).toBe('# Cached body');
    expect(out.citedNoteIds).toEqual(['01N1', '01N2']);
  });

  it('always zeroes spentUsd (cache hits do not bill)', () => {
    const out = rehydrateCachedPacket(mkSerialized({ spentUsd: 9.99 }), {
      mode: 'full',
      scope: 'folder',
      cacheHit: { kind: 'exact' },
    });
    expect(out.spentUsd).toBe(0);
  });

  it('passes through semantic cacheHit metadata', () => {
    const out = rehydrateCachedPacket(mkSerialized(), {
      mode: 'full',
      scope: 'folder',
      cacheHit: { kind: 'semantic', similarity: 0.94 },
    });
    expect(out.cacheHit).toEqual({ kind: 'semantic', similarity: 0.94 });
  });

  it('returns a warned stub when JSON is corrupt', () => {
    const out = rehydrateCachedPacket('{not json', {
      mode: 'full',
      scope: 'folder',
      cacheHit: { kind: 'exact' },
    });
    expect(out.synthesizedMarkdown).toBe('');
    expect(out.warnings).toEqual(['cache row was unparseable; returning stub']);
    expect(out.spentUsd).toBe(0);
    expect(out.bootstrap.taskId).toBeNull();
  });

  it('stub still honours mode + scope overrides', () => {
    const out = rehydrateCachedPacket('not json', {
      mode: 'brief',
      scope: 'workspace',
      cacheHit: { kind: 'semantic', similarity: 0.92 },
    });
    expect(out.mode).toBe('brief');
    expect(out.scope).toBe('workspace');
    expect(out.cacheHit).toEqual({ kind: 'semantic', similarity: 0.92 });
  });
});
