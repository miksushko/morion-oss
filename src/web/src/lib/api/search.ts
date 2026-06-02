import { request } from './http';
import type { SearchHit } from './types';

/** Workspace-wide search. Backed by FTS5 + optional sqlite-vec embeddings;
 *  see `src/core/search/`. */
export const searchApi = {
  search: (q: string) => request<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),
};
