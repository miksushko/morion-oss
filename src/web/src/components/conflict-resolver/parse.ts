/**
 * Conflict-marker parsing for the merge conflict resolver.
 *
 * Extracted from `src/web/src/components/ConflictResolverModal.tsx`
 * on 2026-05-16 so the pure logic (regex parsing + region replacement
 * + leftover-marker counting) can be unit-tested without mounting
 * Monaco. The contract is pinned by `tests/conflict-resolver-parse.test.ts`.
 *
 * Git's textual conflict markers are:
 *
 *     <<<<<<< HEAD
 *     <ours lines>
 *     =======
 *     <theirs lines>
 *     >>>>>>> branch
 *
 * `CONFLICT_RE` is `g`-flagged because the resolver scans drafts
 * with `exec` in a loop; callers MUST reset `lastIndex` between
 * runs or use the wrapper below which does it for them. The
 * separators must be exactly seven characters — `<<<<<<<` /
 * `=======` / `>>>>>>>` — otherwise git wouldn't have written
 * them. The `[^\n]*` tail captures the file-id label git appends
 * (`HEAD`, branch name, etc.) without claiming it as content.
 */

export const CONFLICT_RE = /<{7} [^\n]*\n([\s\S]*?)\n={7}\n([\s\S]*?)\n>{7} [^\n]*/g;
export const LEFTOVER_MARKER_RE = /^(<{7}\s|={7}$|>{7}\s)/m;

export interface ConflictRegion {
  /** Absolute char offset where `<<<<<<< ...` starts. */
  readonly start: number;
  /** Absolute char offset where `>>>>>>> ...` ends (inclusive of
   *  the closing line). */
  readonly end: number;
  /** Substring from `<<<<<<<` line to `=======` (exclusive of
   *  the separator), i.e. the "ours" lines. */
  readonly ours: string;
  /** Substring from `=======` line (exclusive) to `>>>>>>>`
   *  (exclusive), i.e. the "theirs" lines. */
  readonly theirs: string;
}

export function parseConflictRegions(content: string): ConflictRegion[] {
  const regions: ConflictRegion[] = [];
  CONFLICT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONFLICT_RE.exec(content)) !== null) {
    regions.push({
      start: m.index,
      end: m.index + m[0].length,
      ours: m[1] ?? '',
      theirs: m[2] ?? '',
    });
  }
  return regions;
}

/**
 * Replace one conflict region with its accepted form.
 *
 *   - `ours`   → keep HEAD side only
 *   - `theirs` → keep incoming branch side only
 *   - `both`   → keep both, ours then theirs, joined by a newline
 *
 * The result drops the `<<<<<<< ===== >>>>>>>` scaffolding entirely.
 * Caller is responsible for re-parsing the resulting string if more
 * regions remain (the indices in `region` only describe the pre-edit
 * string).
 */
export function applyAccept(
  content: string,
  region: ConflictRegion,
  side: 'ours' | 'theirs' | 'both',
): string {
  const replacement =
    side === 'ours'
      ? region.ours
      : side === 'theirs'
      ? region.theirs
      : `${region.ours}\n${region.theirs}`;
  return content.slice(0, region.start) + replacement + content.slice(region.end);
}

/** Count how many `<<<<<<< ` lines remain across every draft —
 *  the "still has conflicts" gate for the Apply button. */
export function countLeftoverMarkers(drafts: Record<string, string>): number {
  let n = 0;
  for (const content of Object.values(drafts)) {
    n += (content.match(/^<{7}\s/gm) ?? []).length;
  }
  return n;
}

/** Count how many DRAFTS still contain at least one leftover marker
 *  (for the "N files unresolved" footer). */
export function countLeftoverFiles(drafts: Record<string, string>): number {
  let n = 0;
  for (const content of Object.values(drafts)) {
    if (/^<{7}\s/m.test(content)) n++;
  }
  return n;
}
