import type { Note, NoteStatus } from '../../lib/api';
import { NOTE_STATUSES } from '../../lib/api';

/** Return the column key holding `noteId`, or null if the id isn't in any. */
export function findContainer(
  columns: Record<NoteStatus, Note[]>,
  noteId: string,
): NoteStatus | null {
  for (const key of NOTE_STATUSES) {
    if (columns[key].some((n) => n.id === noteId)) return key;
  }
  return null;
}

export type DropResolution =
  | { kind: 'noop' }
  | { kind: 'move'; targetStatus: NoteStatus; afterNoteId: string | null };

/**
 * Pure, side-effect-free translation of a dnd-kit drop event into the
 * call shape `onMoveTask(activeId, targetStatus, afterNoteId)` expects.
 *
 * - `overId` of the form `col:<status>` means top-of-column.
 * - `overId` matching a sibling card translates to "put me where that
 *   card is, push it down" — so afterNoteId becomes the sibling's
 *   PREDECESSOR in the (filtered, sans-active) column. Predecessor=null
 *   collapses back to top-of-column.
 * - Same-column drops where the wanted index equals the current index
 *   collapse to `noop` so the parent skips the server round-trip.
 *
 * Extracted from the inline `handleDragEnd` so the resolution is unit
 * testable without a DOM / dnd-kit harness.
 */
export function resolveDropTarget(
  columns: Record<NoteStatus, Note[]>,
  activeId: string,
  overId: string,
): DropResolution {
  const sourceStatus = findContainer(columns, activeId);
  if (!sourceStatus) return { kind: 'noop' };

  let targetStatus: NoteStatus;
  let afterNoteId: string | null = null;

  if (overId.startsWith('col:')) {
    targetStatus = overId.slice(4) as NoteStatus;
    afterNoteId = null;
  } else {
    if (overId === activeId) return { kind: 'noop' };
    const tStatus = findContainer(columns, overId);
    if (!tStatus) return { kind: 'noop' };
    targetStatus = tStatus;
    const filtered = columns[targetStatus].filter((c) => c.id !== activeId);
    const overIndex = filtered.findIndex((c) => c.id === overId);
    if (overIndex === -1) return { kind: 'noop' };
    afterNoteId = overIndex === 0 ? null : filtered[overIndex - 1]!.id;
  }

  if (sourceStatus === targetStatus) {
    const filtered = columns[targetStatus].filter((c) => c.id !== activeId);
    const targetPrev =
      afterNoteId === null ? null : filtered.find((c) => c.id === afterNoteId);
    const currentIndex = columns[targetStatus].findIndex((c) => c.id === activeId);
    const wantedIndex = targetPrev
      ? filtered.findIndex((c) => c.id === targetPrev.id) + 1
      : 0;
    if (currentIndex === wantedIndex) return { kind: 'noop' };
  }

  return { kind: 'move', targetStatus, afterNoteId };
}
