import type Database from 'better-sqlite3';
import type { z, ZodRawShape } from 'zod';
import type { NotesRepository } from '../../core/notes/repository.js';
import type { FoldersRepository } from '../../core/folders/repository.js';
import type { TagsRepository } from '../../core/tags/repository.js';
import type { RevisionsRepository } from '../../core/revisions/repository.js';
import type { AttachmentsRepository } from '../../core/attachments/repository.js';
import type { NoteCommentsRepository } from '../../core/notes/comments-repository.js';
import type { HybridSearch } from '../../core/search/hybrid.js';
import type { Indexer } from '../../core/search/indexer.js';
import type { EmbeddingProvider } from '../../core/embeddings/provider.js';
import type { GatherProgressEvent } from '../../core/concierge/index.js';
import type { AuditLogger } from '../../core/audit/log.js';
import type { SettingsRepository, ToolCategory } from '../../core/settings/repository.js';
import type {
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  BudgetTracker,
  LLMProvider,
  MoSpendLedgerRepository,
  MoMemoryRepository,
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  MoMetadataVecRepository,
  MoMetadataQueueRepository,
  MoClusterQueueRepository,
  MoPatrolFindingsRepository,
  MoTopicDecisionsRepository,
  MoContextCacheRepository,
} from '../../core/concierge/index.js';

/**
 * Everything a tool handler needs to do its job. Assembled once in
 * `src/server/index.ts` and passed into each registered tool.
 *
 * `actor` identifies the caller in the audit log. For MCP calls it's set to
 * the client name from the MCP initialize request (e.g. `mcp:claude-desktop`).
 * For HTTP calls it's `"user"`.
 */
export interface ToolContext {
  /** The shared SQLite handle. Tools reach for this when they need to
   * bundle multiple repo calls into a single outer transaction — most
   * notably the pre-mutation revision snapshot + the mutation itself,
   * which must be atomic so a crash between them can't orphan a
   * revision without the corresponding update (audit N12, 2026-04-16). */
  db: Database.Database;
  notes: NotesRepository;
  folders: FoldersRepository;
  tags: TagsRepository;
  revisions: RevisionsRepository;
  attachments: AttachmentsRepository;
  comments: NoteCommentsRepository;
  search: HybridSearch;
  indexer: Indexer;
  /** Workspace embedder (Transformers / Noop). Mostly used by the
   *  HybridSearch + Indexer for `notes_vec`; Phase 2 onwards also feeds
   *  `mo_metadata_vec` via the indexing tick. Optional so test fixtures
   *  that don't need embeddings can omit. */
  embeddings?: EmbeddingProvider;
  audit: AuditLogger;
  settings: SettingsRepository;
  actor: string;
  /**
   * Absolute path to the dir containing `morion.db`. Attachment files
   * live at `<configDir>/attachments/<ulid>.<ext>`. Upload handlers pick
   * this up from here rather than re-resolving via `configPaths()` so
   * tests can point attachments at a tmpdir without touching config.
   */
  configDir: string;
  /**
   * Optional side channel for chat-tier Mo to receive progress events
   * from long-running tools (currently only `mo_get_context`'s
   * gather pipeline). The chat dispatch loop in
   * `routes/concierge.ts` builds this per tool-call and the
   * `mo_get_context` handler reads `onGatherProgress` to thread it
   * into `gatherContext`'s `onProgress`. Other tools ignore this
   * field. Absent on the stdio MCP path — no SSE channel exists
   * there. Callbacks must be sync + non-throwing — the gather engine
   * wraps them in try/catch but a slow callback blocks the wave
   * boundary it fired on.
   */
  _chatProgress?: {
    onGatherProgress?: (event: GatherProgressEvent) => void;
  };
  /**
   * Direction V — Morion Concierge subsystem. Bag of repositories + the
   * per-process budget tracker. Absent from MCP tool handlers (MCP
   * tools never touch Concierge) but present in HTTP routes. Optional
   * so existing tool handlers don't need changes; the concierge HTTP
   * route module narrows to required before use.
   */
  concierge?: {
    folderSettings: ConciergeFolderSettingsRepository;
    sessions: ConciergeSessionsRepository;
    messages: ConciergeMessagesRepository;
    moSpendLedger: MoSpendLedgerRepository;
    moMemory: MoMemoryRepository;
    budget: BudgetTracker;
    /** Mo Indexing Redesign Phase 1 storage. Optional so tool-test
     *  fixtures that build their own bag don't have to wire them;
     *  production wiring (`rt.concierge`) always populates them.
     *  Tools that need them assert presence at call time. */
    moMetadata?: NoteMoMetadataRepository;
    moClusters?: NoteMoClustersRepository;
    /** Phase 2 metadata vector store. Backed by `mo_metadata_vec`
     *  (vec0 virtual table); silently no-op when sqlite-vec missing.
     *  Used by deep-context-gather for semantic candidate filtering;
     *  optional for the same reason as the other indexing repos. */
    moMetadataVec?: MoMetadataVecRepository;
    moMetadataQueue?: MoMetadataQueueRepository;
    moClusterQueue?: MoClusterQueueRepository;
    moPatrolFindings?: MoPatrolFindingsRepository;
    /** Topic-cleanup decision memory (mo_topic_decisions). Optional
     *  for the same reason as the other indexing repos — tests wire
     *  their own bag; production always populates. */
    moTopicDecisions?: MoTopicDecisionsRepository;
    /** Phase 5 deep-context-gather two-layer cache (`mo_context_cache`).
     *  Caller derives keys via `buildExactCacheKey` from
     *  `core/concierge/mo-context-cache.js`; semantic match needs an
     *  embedding from `ctx.embeddings`. Optional — when absent, the
     *  gather pipeline simply runs uncached. */
    moContextCache?: MoContextCacheRepository;
    /**
     * Test-only injection point. When set, the chat / tick paths use
     * this provider instead of resolving Groq/OpenRouter from settings.
     * Production paths leave it undefined; the route falls back to the
     * normal `readProviderModel(ctx)` flow. Keeping the override on the
     * bag (vs. a separate route arg) means existing callers that pass
     * `ctx` keep working without signature churn.
     */
    providerOverride?: LLMProvider;
  };
}

/**
 * MCP behavioural hints passed through to `server.registerTool`. All four
 * fields from the MCP spec are here — read-only, destructive, idempotent,
 * open-world — but we only deliberately set `readOnlyHint` and
 * `destructiveHint` per-tool. See `mcp.ts` for the category-based defaults
 * and which tools override them.
 */
export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/**
 * A tool definition is transport-agnostic. The MCP server converts it into
 * a `registerTool` call; tests call `handler` directly with a fake context.
 *
 * `category` drives the per-category MCP gates in the settings UI. Adding a
 * tool requires picking exactly one bucket — there's no sensible default.
 *
 * `annotations` overrides any field of the category-default hints when the
 * tool's actual behaviour diverges (e.g. `notes_append` is `create` by
 * category but `destructiveHint: true` because it mutates existing
 * content; `folders_rename` is `update` by category but
 * `destructiveHint: false` because it's a simple reversible rename).
 */
export interface ToolDef<Shape extends ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly inputShape: Shape;
  readonly annotations?: ToolAnnotations;
  handler(input: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<unknown>;
}

/** Helper to preserve shape typing when declaring a tool. */
export function defineTool<Shape extends ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

/**
 * MCP content item types supported for tool results. The SDK accepts
 * `text`, `image`, and a handful of others; we only use the first two
 * in this codebase. Tools that need to return raw MCP content (image
 * bytes, resource refs) wrap them via `mcpRawContent(...)` so the
 * dispatcher in `mcp.ts` forwards them verbatim instead of JSON-
 * stringifying.
 */
export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpImageContent {
  type: 'image';
  /** Base64-encoded bytes. Claude's vision tokenizer handles it as a
   * vision input (~1-5k tokens per image, independent of raw size)
   * rather than as raw base64 text (which would blow up at ~250k
   * tokens per MB). Always prefer this over JSON'd base64. */
  data: string;
  mimeType: string;
}

export type McpContent = McpTextContent | McpImageContent;

/**
 * Sentinel wrapper marking a tool result as pre-formatted MCP content.
 * The dispatcher in `mcp.ts` checks for the `_mcpContent` key and
 * forwards the array directly to the SDK. Default handlers that return
 * plain JS values get JSON-stringified and wrapped in a text content
 * item — that path is unchanged.
 *
 * Used by `notes_get_attachment` to return the image bytes as
 * `{ type: 'image', data, mimeType }` instead of a string envelope.
 */
export interface McpRawContentResult {
  _mcpContent: McpContent[];
  /** Surface this result as `isError: true` so Claude's error handling
   * fires instead of silently accepting the payload. */
  isError?: boolean;
}

export function mcpRawContent(
  content: McpContent[],
  options: { isError?: boolean } = {},
): McpRawContentResult {
  return { _mcpContent: content, isError: options.isError };
}

export function isRawContentResult(x: unknown): x is McpRawContentResult {
  return (
    typeof x === 'object' &&
    x !== null &&
    '_mcpContent' in (x as Record<string, unknown>) &&
    Array.isArray((x as { _mcpContent: unknown })._mcpContent)
  );
}
