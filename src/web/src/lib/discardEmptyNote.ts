import type { Note } from './api';

/**
 * Apple Notes-style empty-note predicate. A note is "empty" — and therefore
 * eligible for silent discard when the user navigates away from it — if the
 * user has not put anything into it: no body text, no tags. Whitespace
 * doesn't count as content (otherwise a stray newline from the editor would
 * defeat the discard).
 *
 * Title is derived from the body, so there is no separate title check — an
 * empty body already implies an empty title.
 *
 * Only the *intent-bearing* fields are checked. The note's id, timestamps,
 * folder, and source are deliberately ignored — moving an empty draft into
 * a folder still leaves it empty for the purpose of this check. App.tsx
 * keeps every UI-session-created note in the discard-eligible set for the
 * whole session, so this predicate is re-evaluated on every navigation:
 * a note the user typed into and then erased back to empty is just as
 * discardable as one that was never touched.
 */
export function isEmptyDraftNote(note: Pick<Note, 'body'>): boolean {
  // Strip markdown structural remnants that Tiptap leaves behind:
  // - empty headings: `#`, `##`, `###` (with optional trailing space)
  // - blank lines / whitespace
  // After stripping, if nothing remains the note is empty.
  // Tags are NOT considered content — an empty body with tags is still empty.
  const stripped = note.body
    .replace(/^#{1,6}\s*$/gm, '') // lone heading markers
    .trim();
  return stripped === '';
}
