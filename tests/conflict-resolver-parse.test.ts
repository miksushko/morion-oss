/**
 * Contract pin for the pure helpers extracted from
 * `src/web/src/components/ConflictResolverModal.tsx` on 2026-05-16.
 * Per Morion ticket 01KRQS8PFFZ7WDM0JRB6FZCADE — covers
 * parseConflictRegions on real `<<<<<<< / ======= / >>>>>>>` blocks,
 * applyAccept ours/theirs/both, and the leftover counters.
 */
import { describe, expect, it } from 'vitest';

import {
  CONFLICT_RE,
  LEFTOVER_MARKER_RE,
  applyAccept,
  countLeftoverFiles,
  countLeftoverMarkers,
  parseConflictRegions,
} from '../src/web/src/components/conflict-resolver/parse.js';

const NL = '\n';

function buildConflict(ours: string, theirs: string, label = 'HEAD', branch = 'feature'): string {
  return [
    `<<<<<<< ${label}`,
    ours,
    '=======',
    theirs,
    `>>>>>>> ${branch}`,
  ].join(NL);
}

describe('parseConflictRegions', () => {
  it('returns [] when there are no conflict markers', () => {
    expect(parseConflictRegions('hello\nworld\n')).toEqual([]);
  });

  it('parses one conflict region with ours + theirs payloads', () => {
    const content = `prefix\n${buildConflict('line ours', 'line theirs')}\nsuffix\n`;
    const regions = parseConflictRegions(content);
    expect(regions).toHaveLength(1);
    expect(regions[0].ours).toBe('line ours');
    expect(regions[0].theirs).toBe('line theirs');
    // Region start should point at `<<<<<<<`.
    expect(content.slice(regions[0].start, regions[0].start + 7)).toBe('<<<<<<<');
    // Region end should be just past `>>>>>>> feature`.
    expect(content.slice(regions[0].end, regions[0].end + 1)).toBe('\n');
  });

  it('parses multiple sequential regions in the same file', () => {
    const content = [
      buildConflict('a-ours', 'a-theirs'),
      'middle',
      buildConflict('b-ours', 'b-theirs'),
    ].join(NL);
    const regions = parseConflictRegions(content);
    expect(regions).toHaveLength(2);
    expect(regions[0].ours).toBe('a-ours');
    expect(regions[1].theirs).toBe('b-theirs');
    expect(regions[0].end).toBeLessThan(regions[1].start);
  });

  it('handles multi-line ours / theirs payloads', () => {
    const content = buildConflict('o1\no2\no3', 't1\nt2');
    const regions = parseConflictRegions(content);
    expect(regions).toHaveLength(1);
    expect(regions[0].ours).toBe('o1\no2\no3');
    expect(regions[0].theirs).toBe('t1\nt2');
  });

  it('captures the branch labels via the [^\\n]* tail without claiming them as content', () => {
    const content = buildConflict('x', 'y', 'HEAD', 'fancy/branch-name');
    const regions = parseConflictRegions(content);
    expect(regions).toHaveLength(1);
    expect(regions[0].ours).toBe('x');
    expect(regions[0].theirs).toBe('y');
  });

  it('resets internal lastIndex between calls (callable repeatedly)', () => {
    const content = buildConflict('a', 'b');
    expect(parseConflictRegions(content)).toHaveLength(1);
    expect(parseConflictRegions(content)).toHaveLength(1);
    expect(parseConflictRegions(content)).toHaveLength(1);
  });
});

describe('applyAccept', () => {
  const content = `head\n${buildConflict('OURS', 'THEIRS')}\ntail`;
  const region = parseConflictRegions(content)[0]!;

  it('keeps only the ours payload when side="ours"', () => {
    const next = applyAccept(content, region, 'ours');
    expect(next).toBe('head\nOURS\ntail');
    // No leftover markers.
    expect(LEFTOVER_MARKER_RE.test(next)).toBe(false);
  });

  it('keeps only the theirs payload when side="theirs"', () => {
    const next = applyAccept(content, region, 'theirs');
    expect(next).toBe('head\nTHEIRS\ntail');
    expect(LEFTOVER_MARKER_RE.test(next)).toBe(false);
  });

  it('keeps both payloads joined by a newline when side="both"', () => {
    const next = applyAccept(content, region, 'both');
    expect(next).toBe('head\nOURS\nTHEIRS\ntail');
    expect(LEFTOVER_MARKER_RE.test(next)).toBe(false);
  });

  it('only affects the targeted region, leaving sibling regions intact', () => {
    const multi = `A\n${buildConflict('o1', 't1')}\nB\n${buildConflict('o2', 't2')}\nC`;
    const [first, second] = parseConflictRegions(multi);
    const afterFirst = applyAccept(multi, first!, 'ours');
    // Second region survives (we mutate by absolute offsets — caller
    // re-parses afterwards before the next call).
    const afterRegions = parseConflictRegions(afterFirst);
    expect(afterRegions).toHaveLength(1);
    expect(afterRegions[0].ours).toBe('o2');
    expect(afterRegions[0].theirs).toBe('t2');
    // And the indices in `second` are now stale — that's by design.
    expect(second!.start).not.toBe(afterRegions[0].start);
  });
});

describe('countLeftoverMarkers + countLeftoverFiles', () => {
  it('returns 0 / 0 for an empty drafts map', () => {
    expect(countLeftoverMarkers({})).toBe(0);
    expect(countLeftoverFiles({})).toBe(0);
  });

  it('returns 0 / 0 for drafts that have no markers', () => {
    const drafts = { 'a.ts': 'pure\ncode\n', 'b.css': '.x { color: red }' };
    expect(countLeftoverMarkers(drafts)).toBe(0);
    expect(countLeftoverFiles(drafts)).toBe(0);
  });

  it('counts each `<<<<<<< ` line once', () => {
    const drafts = {
      'a.ts': buildConflict('a', 'b'),
      'b.ts': `${buildConflict('c', 'd')}\nbreak\n${buildConflict('e', 'f')}`,
      'c.ts': 'clean',
    };
    expect(countLeftoverMarkers(drafts)).toBe(3);
    expect(countLeftoverFiles(drafts)).toBe(2);
  });

  it('counts only the OPEN marker, not the `=======` / `>>>>>>>` lines', () => {
    // Hand-crafted: only the closing markers, no opening — wouldn't
    // happen in a real git output but proves the count regex isn't
    // over-eager.
    const drafts = { 'a.ts': '=======\n>>>>>>> something\n' };
    expect(countLeftoverMarkers(drafts)).toBe(0);
    expect(countLeftoverFiles(drafts)).toBe(0);
  });
});

describe('CONFLICT_RE regex shape', () => {
  it('requires at least seven `<` chars — 6 does not match', () => {
    // git itself always emits exactly seven; we accept "≥ 7" in
    // practice because the regex slides forward to the first valid
    // start position, but six chars is definitely not enough.
    const sixChars = '<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feat';
    expect(parseConflictRegions(sixChars)).toEqual([]);
  });

  it('matches when separator lines are exactly the git format', () => {
    const ok = '<<<<<<< HEAD\nour\n=======\ntheir\n>>>>>>> feat';
    expect(parseConflictRegions(ok)).toHaveLength(1);
  });

  it('does not match when the `=======` separator has a trailing char on the line', () => {
    // CONFLICT_RE requires the separator line to be exactly seven `=`
    // followed by `\n`. A trailing comment would fail.
    const broken = '<<<<<<< HEAD\nour\n======= junk\ntheir\n>>>>>>> feat';
    expect(parseConflictRegions(broken)).toEqual([]);
  });
});
