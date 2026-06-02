/** Search domain types. Imports Note from ./notes for SearchHit. */

import type { Note } from './notes';

export interface SearchHit {
  note: Note;
  score: number;
  snippet: string | null;
}
