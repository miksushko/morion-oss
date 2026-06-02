import {
  buildMoMetadataEmbedText,
  listMoMetadataVecBackfillCandidates,
} from '../mo-metadata-vec.js';
import { VEC_BACKFILL_BATCH, type MoIndexingTickDeps } from './internals.js';

/**
 * Step 1b — Phase 2 embedding backfill. Notes WITH Tier 1 metadata
 * but WITHOUT a `mo_metadata_vec` row. Happens for any note whose
 * metadata was computed before Phase 2 shipped, or while sqlite-vec
 * / the embedder was unavailable. Cheap deterministic local op
 * (no LLM, no spend), runs inline rather than through
 * `mo_metadata_queue` so we don't conflate paid-LLM work with local
 * embedding fill. Cap per tick keeps tick latency bounded
 * (~50ms × cap is the worst case for embedder-cold-start runs).
 *
 * Whole pass is a no-op when `vec` or `embeddings` is missing —
 * downstream context-gather degrades to keyword search.
 */
export async function runVecBackfill(
  deps: MoIndexingTickDeps,
): Promise<{ backfilled: number; skipped: number } | null> {
  if (!deps.vec || !deps.embeddings) return null;
  const candidates = listMoMetadataVecBackfillCandidates(
    deps.db,
    VEC_BACKFILL_BATCH,
  );
  let backfilled = 0;
  let skipped = 0;
  for (const c of candidates) {
    const text = buildMoMetadataEmbedText(c.summary, c.keywords);
    if (text === null) {
      skipped++;
      continue;
    }
    try {
      const vector = await deps.embeddings.embed(text, 'passage');
      if (vector === null) {
        // Embedder turned unavailable mid-sweep — bail out of the
        // batch; subsequent ticks will retry once it recovers.
        skipped++;
        break;
      }
      deps.vec.upsert(c.noteId, vector);
      backfilled++;
    } catch {
      skipped++;
    }
  }
  return { backfilled, skipped };
}
