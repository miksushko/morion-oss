/**
 * Abstraction over embedding backends. The system must keep working when
 * embeddings are unavailable, so callers treat a null result as "no vector".
 *
 * The `kind` parameter lets asymmetric models (E5, BGE, etc.) apply a
 * `"query: "` or `"passage: "` prefix for best retrieval quality. Symmetric
 * models can ignore it.
 */
export interface EmbeddingProvider {
  /** Vector dimensionality. Must match the notes_vec virtual table. */
  readonly dim: number;
  /** Embed a single text. Returns null when the backend is unreachable. */
  embed(text: string, kind?: 'query' | 'passage'): Promise<Float32Array | null>;
  /** Quick health check used at startup. */
  available(): Promise<boolean>;
}
