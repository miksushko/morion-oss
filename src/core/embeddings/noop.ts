import type { EmbeddingProvider } from './provider.js';

/**
 * Fallback provider used when the real embedding backend can't be loaded or
 * the user has explicitly opted out of semantic search. HybridSearch sees
 * `null` from embed() and falls back cleanly to FTS5-only ranking.
 */
export class NoopEmbeddings implements EmbeddingProvider {
  readonly dim: number;

  constructor(dim = 384) {
    this.dim = dim;
  }

  async embed(): Promise<null> {
    return null;
  }

  async available(): Promise<boolean> {
    return false;
  }
}
