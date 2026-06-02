import type { EmbeddingProvider } from './provider.js';

/**
 * In-process embedding provider built on @huggingface/transformers (ONNX Runtime).
 * Zero external dependencies: no daemon, no API key, no network after the first
 * run. The model is lazy-loaded on the first call and cached for the lifetime
 * of the process.
 *
 * Default model is `Xenova/multilingual-e5-small`:
 *   - 384-dim sentence embeddings
 *   - ~120 MB quantized download
 *   - multilingual (100+ languages, matters for mixed EN/RU notes)
 *   - E5 family requires "query: " / "passage: " prefixes for best quality
 *
 * Cache resolution (`@huggingface/transformers`'s `env`):
 *   - `MORION_HF_CACHE_DIR` overrides the on-disk download cache. Defaults to
 *     `~/.cache/huggingface`. Tauri sidecar sets it to `<app config>/hf-cache`.
 *   - `MORION_HF_LOCAL_MODEL_PATH` points at a directory of pre-extracted
 *     model files (Tauri ships the model inside `Resources/`). When set,
 *     `env.allowRemoteModels = false` so the binary refuses to phone home.
 *
 * If ONNX runtime fails to initialise (missing native binary, corrupt cache),
 * embed() returns null so HybridSearch transparently degrades to FTS5-only.
 */

const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';
const DEFAULT_DIM = 384;

type FeatureExtractionPipeline = (
  text: string,
  options: { pooling: 'mean' | 'cls' | 'none'; normalize: boolean },
) => Promise<{ data: Float32Array }>;

export class TransformersEmbeddings implements EmbeddingProvider {
  readonly dim: number;
  private readonly model: string;
  private pipelinePromise: Promise<FeatureExtractionPipeline | null> | null = null;

  constructor(model: string = DEFAULT_MODEL, dim: number = DEFAULT_DIM) {
    this.model = model;
    this.dim = dim;
  }

  async embed(text: string, kind: 'query' | 'passage' = 'passage'): Promise<Float32Array | null> {
    const pipe = await this.getPipeline();
    if (!pipe) return null;

    const prefixed = `${kind}: ${text}`;
    const output = await pipe(prefixed, { pooling: 'mean', normalize: true });
    if (output.data.length !== this.dim) return null;
    return output.data;
  }

  async available(): Promise<boolean> {
    return (await this.getPipeline()) !== null;
  }

  private getPipeline(): Promise<FeatureExtractionPipeline | null> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = import('@huggingface/transformers')
        .then(async ({ pipeline, env }) => {
          // Apply env overrides BEFORE the first pipeline() call so the
          // resolver picks them up. Doing this lazily (here, not at module
          // top level) keeps the import cost out of the noop path.
          const cacheDir = process.env.MORION_HF_CACHE_DIR;
          if (cacheDir && cacheDir.length > 0) {
            env.cacheDir = cacheDir;
          }
          const localModelPath = process.env.MORION_HF_LOCAL_MODEL_PATH;
          if (localModelPath && localModelPath.length > 0) {
            env.localModelPath = localModelPath;
            // Local-first hard requirement: when a bundled model dir is
            // specified, never fall back to the HF hub.
            env.allowRemoteModels = false;
          }
          const pipe = (await pipeline('feature-extraction', this.model)) as unknown as FeatureExtractionPipeline;
          return pipe;
        })
        .catch(() => null);
    }
    return this.pipelinePromise;
  }
}
