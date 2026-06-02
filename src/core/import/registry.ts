import type { ImportEngine } from './engine.js';
import type { ImportEvent, ImportSummary } from './types.js';

/**
 * In-process registry that enforces the "one active import at a time"
 * invariant per workspace.
 *
 * Why global serialization: parallel imports across distinct destination
 * folders would technically work, but the UX promise is "you started an
 * import, watch it finish before starting another". Two concurrent
 * imports also race on the same `notes` table, increasing SQLITE_BUSY
 * surface area for users with slower disks. One at a time keeps the
 * mental model + SQLite happy.
 *
 * Within a single import, parallelism is delegated to `ImportEngine`'s
 * own `fileConcurrency` setting — that's safe because the engine
 * coordinates its own writers.
 *
 * The registry also caches the last N completed batch summaries so a
 * client that connects late (e.g. modal reopened on app restart) can
 * still see the final result.
 */

const COMPLETED_BATCHES_KEPT = 10;

export interface ActiveImport {
  engine: ImportEngine;
  startedAt: number;
}

export class ImportRegistry {
  private active: ActiveImport | null = null;
  private readonly recent: Array<{ batchId: string; summary: ImportSummary }> = [];
  /** Per-batch event ring buffer for late SSE subscribers. */
  private readonly eventBuffers = new Map<string, ImportEvent[]>();

  /**
   * Register the engine as the active import. Throws if another import
   * is already active. Caller MUST call `release(batchId)` (typically
   * via finally on the engine.run promise).
   */
  reserve(engine: ImportEngine): void {
    if (this.active !== null) {
      throw new Error('Another import is already in progress.');
    }
    this.active = {
      engine,
      startedAt: Date.now(),
    };
    // Tee events into the per-batch buffer so late SSE clients can
    // replay everything that happened before they connected.
    const buffer: ImportEvent[] = [];
    this.eventBuffers.set(engine.id, buffer);
    engine.events.on('event', (e: ImportEvent) => {
      buffer.push(e);
      if (e.type === 'complete' || e.type === 'cancelled') {
        if (e.summary) {
          this.recent.push({ batchId: e.batchId, summary: e.summary });
          while (this.recent.length > COMPLETED_BATCHES_KEPT) this.recent.shift();
        }
      }
    });
  }

  release(batchId: string): void {
    if (this.active && this.active.engine.id === batchId) {
      this.active = null;
    }
    // Keep the event buffer around for the LIFETIME constant so late
    // subscribers can still see it. Garbage collected via shift on
    // overflow when more recent imports complete.
    while (this.eventBuffers.size > COMPLETED_BATCHES_KEPT) {
      const oldest = this.eventBuffers.keys().next().value;
      if (oldest) this.eventBuffers.delete(oldest);
    }
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  /** Currently-active batch id or null. */
  activeBatchId(): string | null {
    return this.active?.engine.id ?? null;
  }

  /** Find an active or recently-completed batch by id. */
  findEngine(batchId: string): ImportEngine | null {
    if (this.active && this.active.engine.id === batchId) return this.active.engine;
    return null;
  }

  /** Replay buffered events for a batch (active or recent). Returns []
   *  if the batch has been GC'd. */
  bufferedEvents(batchId: string): ImportEvent[] {
    return this.eventBuffers.get(batchId)?.slice() ?? [];
  }

  /** Recent completed summaries — newest last. */
  recentSummaries(): Array<{ batchId: string; summary: ImportSummary }> {
    return this.recent.slice();
  }
}
