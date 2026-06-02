/**
 * Notes-list date grouping. Thin wrapper over the workspace-shared
 * `lib/groupByDate.ts` that picks the right timestamp field (live view
 * uses `updatedAt`, trash view uses `deletedAt` with `updatedAt`
 * fallback) and preserves the `pinned` carve-out at the top.
 *
 * Returns `{label, notes}[]` (the legacy shape NotesList renders) rather
 * than the generic `DateGroup<T>` shape — keeps the JSX call site short.
 */

import type { Note } from '../../lib/api';
import { groupByDate, type GroupByDateOptions } from '../../lib/groupByDate';

export type NoteGroupTimestamp = 'updatedAt' | 'deletedAt';

export interface NoteGroup {
  label: string;
  notes: Note[];
}

export function groupNotesByDate(
  notes: Note[],
  tsKey: NoteGroupTimestamp,
  opts: Pick<GroupByDateOptions<Note>, 'now'> = {},
): NoteGroup[] {
  const groups = groupByDate(
    notes,
    (n) => (tsKey === 'deletedAt' ? (n.deletedAt ?? n.updatedAt) : n.updatedAt),
    { pinFn: (n) => n.pinned, now: opts.now },
  );
  return groups.map((g) => ({ label: g.label, notes: g.items }));
}
