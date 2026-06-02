import type { Note, NoteStatus } from './api';
import { NOTE_STATUSES } from './api';

/**
 * Return the cards of a kanban folder flattened in the exact visual order
 * the board renders them. Column order matches `NOTE_STATUSES` (note →
 * backlog → todo → doing → review → done); inside each column:
 *   - `note` sorts by `updated_at DESC` (chronological reference pile)
 *   - the five workflow columns sort by `position ASC` with `created_at
 *     DESC` tie-break
 *
 * Used by:
 *   - `KanbanView` to group cards into columns (bucket by status then
 *     slice from the pre-sorted flat list).
 *   - `App.tsx` to find the prev/next neighbour of the currently open
 *     card — powers the ClickUp-style up/down navigator in the card
 *     modal header. Single ordering source keeps the board and the
 *     navigator honest; if the board shows card X between A and B, the
 *     navigator's arrows land on A and B, period.
 */
export function orderKanbanCards(notes: Note[]): Note[] {
  const buckets: Record<NoteStatus, Note[]> = {
    note: [],
    backlog: [],
    todo: [],
    doing: [],
    review: [],
    done: [],
  };
  for (const n of notes) {
    (buckets[n.status] ?? buckets.note).push(n);
  }
  buckets.note.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const key of NOTE_STATUSES) {
    if (key === 'note') continue;
    buckets[key].sort((a, b) => {
      const ap = a.position ?? Infinity;
      const bp = b.position ?? Infinity;
      if (ap !== bp) return ap - bp;
      return b.createdAt - a.createdAt;
    });
  }
  return NOTE_STATUSES.flatMap((s) => buckets[s]);
}

/**
 * Columns object keyed by status, each value a pre-sorted array. Cheap to
 * derive from `orderKanbanCards` but handy for the board renderer, which
 * wants buckets, not a flat list.
 */
export function bucketKanbanCards(notes: Note[]): Record<NoteStatus, Note[]> {
  const buckets: Record<NoteStatus, Note[]> = {
    note: [],
    backlog: [],
    todo: [],
    doing: [],
    review: [],
    done: [],
  };
  for (const card of orderKanbanCards(notes)) {
    buckets[card.status].push(card);
  }
  return buckets;
}

/**
 * Return `{ prevId, nextId }` for the given `currentId` within the
 * kanban-order flat list. Either neighbour is null when the current card
 * is at that end of the board (first card of `note` column → prevId null;
 * last card of `done` column → nextId null).
 *
 * Within a column the arrows walk position-by-position. At a column
 * boundary they wrap into the last card of the previous column / first
 * card of the next — the user thinks of the board as one ordered list,
 * not six silos.
 */
export function kanbanCardNeighbours(
  notes: Note[],
  currentId: string,
): { prevId: string | null; nextId: string | null } {
  const flat = orderKanbanCards(notes);
  const idx = flat.findIndex((n) => n.id === currentId);
  if (idx === -1) return { prevId: null, nextId: null };
  return {
    prevId: idx > 0 ? flat[idx - 1]!.id : null,
    nextId: idx < flat.length - 1 ? flat[idx + 1]!.id : null,
  };
}
