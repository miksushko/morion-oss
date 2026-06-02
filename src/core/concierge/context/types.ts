import type { LLMProvider } from '../provider.js';
import type { BudgetTracker } from '../budget.js';
import type { ToolContext } from '../../../server/tools/types.js';

/**
 * Phase 7 — context restructure ticket `01KQFQ1RJV7EH0X3WF2H1A476J`.
 *
 * Public types for the deep-context-gather engine. Two callers:
 *   - `mo_get_context` MCP tool (returns the packet directly)
 *   - `mo_ask` MCP tool (post-formats the packet as a cited paragraph)
 *
 * Both share the same internal pipeline (bootstrap → Wave 1 → Wave 2
 * → synth) and the same `WorkContextPacket` shape; only the output
 * formatting differs.
 */

/**
 * Caller-supplied input for one gather call. Two starting modes:
 *   - `taskId` set: bootstrap from the task (folder + clusters +
 *     metadata + comments + audit). Wave 1 fans out per cluster.
 *   - `question` set: bootstrap from the catalog (when folderId given)
 *     or skip catalog (workspace scope). Wave 1 generates keywords.
 *
 * Exactly one of `taskId` / `question` must be present. Caller is
 * responsible for validating + denying when both / neither are given.
 */
export interface GatherInput {
  taskId?: string;
  question?: string;
  /** Optional folder scope. When omitted on the question path,
   *  workspace-wide scope applies. Required for `taskId` only via
   *  resolved folder — caller doesn't pass it. */
  folderId?: string | null;
  /** `'folder'` (default when folderId set) or `'workspace'` (when
   *  unscoped). Used as cache partition key. */
  scope?: 'folder' | 'workspace';
  /** `'full'` (default), `'resume'` (handoff-style focus on comments +
   *  audit), `'thorough'` (synth model bumped to deepseek-v4-pro). */
  mode?: 'full' | 'resume' | 'thorough';
  /** When true, bypass both cache layers + force a fresh gather. */
  force?: boolean;
}

export interface GatherDeps {
  /** Tool context — passed through from the MCP handler. Internal
   *  reads use `toMoInternalCtx(ctx)` per Phase 3. */
  ctx: ToolContext;
  /** Provider for sub-Mo + synth calls. */
  provider: LLMProvider;
  /** Cheap-tier model for sub-Mos (qwen3.5-flash recommended). */
  subagentModel: string;
  /** Synth model — deepseek-v4-flash for `mode: 'full'`,
   *  deepseek-v4-pro for `mode: 'thorough'`. Caller picks. */
  synthesisModel: string;
  /** Budget tracker. Pre-flight check + per-wave check. */
  budget: BudgetTracker;
  /** Hard caps. Defaults applied per field by `gatherContext`. */
  caps?: Partial<GatherCaps>;
  /** Optional progress callback. Fires at boundary of each wave +
   *  body-read milestone. Phase 10 wires this to SSE; Phase 7 just
   *  exposes the hook. */
  onProgress?: (event: GatherProgressEvent) => void;
}

export interface GatherCaps {
  /** USD. Pre-flight check: if Mo's monthly budget remaining < this,
   *  refuse the call. Per-wave check: if remaining < this, abort
   *  before the next wave. Default $0.10. */
  maxUsd: number;
  /** Max body reads (Wave 2 body-extractor calls). Default 15. */
  maxBodyReads: number;
  /** Max fan-out waves (Bootstrap doesn't count). Default 3. */
  maxWaves: number;
  /** Sub-Mo concurrency cap. Default 10. */
  subagentConcurrency: number;
}

export const DEFAULT_GATHER_CAPS: GatherCaps = {
  maxUsd: 0.1,
  maxBodyReads: 15,
  maxWaves: 3,
  subagentConcurrency: 10,
};

export type GatherProgressEvent =
  | { kind: 'cache_hit_exact'; cacheKey: string }
  | { kind: 'cache_hit_semantic'; similarity: number }
  | { kind: 'bootstrap_complete'; folderId: string | null; clusterCount: number }
  | {
      kind: 'wave_start';
      wave: 1 | 2 | 3;
      subMoCount: number;
    }
  | {
      kind: 'wave_complete';
      wave: 1 | 2 | 3;
      okCount: number;
      failedCount: number;
      spentUsd: number;
    }
  | { kind: 'synthesis_start' }
  | { kind: 'synthesis_complete'; spentUsd: number }
  | { kind: 'capped'; reason: 'budget_exhausted' | 'body_read_cap' | 'wave_cap' };

// ---------------------------------------------------------------------
// WorkContextPacket — the output shape
// ---------------------------------------------------------------------

/**
 * Final structured result from a gather call. Caller formats this for
 * its medium:
 *   - `mo_get_context` returns it as-is (markdown + structured refs)
 *   - `mo_ask` post-formats `packetMarkdown` as a paragraph answer
 *
 * `cacheHit` field tells the caller whether the packet came from cache
 * (and at what similarity for semantic hits). Agents that want
 * guaranteed-fresh results pass `force: true` on the input.
 */
export interface WorkContextPacket {
  /** Echo of the gather input (mode, scope) so the response is
   *  self-describing for downstream tooling. */
  mode: GatherInput['mode'];
  scope: 'folder' | 'workspace';
  /** Resolved bootstrap state — what Mo found locally before any
   *  fan-out. Always populated; useful for diagnosis when
   *  `synthesizedMarkdown` ends up empty. */
  bootstrap: {
    taskId: string | null;
    folderId: string | null;
    clusterIds: string[];
    /** Note ids of every comment / audit row Mo read in bootstrap.
     *  Caller can render "Mo opened these N pieces of context" for UX. */
    commentCount: number;
    auditCount: number;
  };
  /** The synthesised markdown body. Empty string when synthesis was
   *  skipped (cache hit doesn't skip; only an aborted-via-cap path
   *  would). Always check `capped` before `synthesizedMarkdown.length`. */
  synthesizedMarkdown: string;
  /** Note ids the synthesis cited. Used for deeplink / UI badges. */
  citedNoteIds: string[];
  /** Risks pulled out of the synthesis for prominent display. */
  risks: string[];
  /** Cache provenance:
   *    null = freshly synthesised
   *    'exact' = exact-key cache hit (TTL 1h)
   *    'semantic' = nearest-neighbour cache hit (cosine ≥ 0.92) */
  cacheHit: null | { kind: 'exact' } | { kind: 'semantic'; similarity: number };
  /** Total USD spent on THIS call (sub-Mos + synth). 0 when fully
   *  cached. */
  spentUsd: number;
  /** True iff a hard cap fired mid-call. The packet is still returned
   *  with whatever Mo gathered before the cap. */
  capped: null | 'budget_exhausted' | 'body_read_cap' | 'wave_cap';
  /** Telemetry — useful for debugging "why did Mo return so little".
   *  Sum of failed + skipped sub-Mo tasks across all waves. */
  warnings: string[];
}
