import type { Note } from '../notes/types.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { VecIndex } from './vec.js';

/**
 * Keeps the vector index in sync with note mutations. Called by every MCP tool
 * and HTTP route that creates or updates a note. Embedding failures are
 * swallowed on purpose — the note is still written to SQLite and FTS5 still
 * works, we just lose the semantic signal for that row until it's re-indexed.
 *
 * Uses the 'passage' kind, which matches the E5 family convention. Query-side
 * prefixes happen inside HybridSearch.
 */
export class Indexer {
  constructor(
    private readonly vec: VecIndex,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async reindex(note: Note): Promise<void> {
    // Title is already the first line of body (post-migration), embed body directly
    const text = note.body;
    const embedding = await this.embeddings.embed(text, 'passage');
    if (embedding) this.vec.upsert(note.id, embedding);
  }

  remove(noteId: string): void {
    this.vec.delete(noteId);
  }
}
