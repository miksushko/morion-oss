import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { NotesRepository } from '../notes/repository.js';
import type { LLMProvider, LLMRequest, LLMMessage } from './provider.js';
import { completeWithFallback } from './provider.js';
import type { BudgetTracker } from './budget.js';
import { spendInputFromLLMResponse } from './mo-spend-ledger.js';
import type { NoteMoMetadataRepository } from './mo-metadata-repository.js';
import type { NoteMoClustersRepository } from './mo-clusters-repository.js';
import type { MoComputedBy } from './mo-metadata-repository.js';
import type { MoMetadataVecRepository } from './mo-metadata-vec.js';
import { buildMoMetadataEmbedText } from './mo-metadata-vec.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';

/**
 * Mo Indexing Redesign — Phase 2a Tier 1 per-note map.
 *
 * Single-note classifier: read body, ask the cheap-tier LLM for
 * `summary` + `keywords` + ranked `clusters[]`, persist via the
 * Phase 1 metadata + clusters repositories. Body-hash gate at the
 * top — if `note.body` hashes to the cached value the note is fresh,
 * we skip the LLM call entirely.
 *
 * No event-bus subscriber here, no worker pool — those are Phases 2b
 * and 2c. Phase 2a is the pure callable function plus its prompt /
 * parse helpers, testable with a stub `LLMProvider`.
 *
 * Spend goes to `mo_tool` (existing `MoSpendKind`); a dedicated
 * `'patrol'` breakdown bucket would be nice UX but extending the enum
 * touches DB schema + UI breakdown — deferred.
 *
 * Output contract is a strict JSON shape with `cluster_candidates` as
 * an ARRAY (many-to-many; one note legitimately fits several themes —
 * see CLAUDE.md "Mo indexing redesign" invariants). The model picks
 * from `knownClusters` when a candidate fits and proposes new ids
 * otherwise; either way the JOIN row's `source` is `'tier1'` so a
 * later user override (`source='user'`) replaces it via
 * `replaceForNote(preserveUserOverrides: true)`.
 */

export interface Tier1ClusterCandidate {
  clusterId: string;
  confidence: number;
}

export interface Tier1Output {
  summary: string;
  keywords: string[];
  clusterCandidates: Tier1ClusterCandidate[];
}

export interface Tier1RunDeps {
  db: Database.Database;
  notes: NotesRepository;
  metaRepo: NoteMoMetadataRepository;
  clustersRepo: NoteMoClustersRepository;
  provider: LLMProvider;
  budget?: BudgetTracker;
  model: string;
  fallbackModel?: string | null;
  /** Provider id for the spend ledger. Defaults to provider.name. */
  providerName?: string;
  /**
   * Phase 2 embedding pipeline. When BOTH `vec` and `embeddings` are
   * supplied, Tier 1 computes an embedding of `summary + keywords` and
   * writes it to `mo_metadata_vec` after the metadata transaction
   * commits. Either undefined / null embedder result / vec disabled →
   * silent no-op (the metadata write itself is unaffected). The
   * downstream context-gather (`mo_get_context`) uses these vectors for
   * semantic candidate filtering; without them it falls back to
   * keyword + cluster routing.
   */
  vec?: MoMetadataVecRepository;
  embeddings?: EmbeddingProvider;
}

export interface Tier1RunOptions {
  /** Recompute even if hash matches the cache. */
  force?: boolean;
  /** Override Date.now (tests). */
  now?: number;
  /** Cluster ids the model should prefer when assigning candidates. */
  knownClusters?: string[];
  /** Per-folder generic-terms blocklist, free-text. The Tier 1 prompt
   *  inlines it verbatim; empty / omitted means "no per-folder rules,
   *  only the workspace category rules apply". */
  topicExclusions?: string;
  /** Override the `computed_by` tag. Default `'tier1'`. */
  computedBy?: MoComputedBy;
}

export type Tier1RunResult =
  | {
      status: 'fresh';
      bodyHash: string;
      reason: 'hash_match' | 'hands_off' | 'empty_body' | 'system_note';
    }
  | {
      status: 'computed';
      bodyHash: string;
      output: Tier1Output;
      costUsd: number;
      tokensIn: number | null;
      tokensOut: number | null;
    }
  | {
      status: 'error';
      bodyHash: string | null;
      reason: 'note_not_found' | 'invalid_json' | 'budget_exceeded' | 'provider_failed';
      message: string;
    };

/** SHA-256 hex of a note body. Stable hash key for the dirty-detection
 *  cache; chosen over a faster non-cryptographic hash because (a) we
 *  already pay sha256 in attachments + license verification, no extra
 *  bundle weight, and (b) collision resistance lets us trust hash
 *  equality as semantic equality. */
export function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

const MIN_TIER1_BODY_CHARS = 30;

/** Build the messages a Tier 1 LLM call sends. Pure — tests pin the
 *  prompt shape so future model changes don't drift it silently.
 *
 *  Three blocks combine in the system prompt:
 *  1. The principle of what makes a good topic (module / location /
 *     concrete technology — not status / OS / ticket-type).
 *  2. The folder's existing cluster ids (so the model reuses instead
 *     of coining duplicates — the core fix for topic drift).
 *  3. Optional per-folder generic-terms blocklist set by the user
 *     (e.g. "task management", "agile" for a workflow product whose
 *     entire folder is about workflow — those words don't help
 *     retrieval inside the folder).
 *
 *  We deliberately describe FORBIDDEN CATEGORIES, not enumerate every
 *  forbidden word. The category list is short and stable; an enumerated
 *  blacklist would need monthly maintenance and still leak words like
 *  `tablet` or `chromeos` that didn't exist when it was written. */
export function buildTier1Messages(
  body: string,
  knownClusters: string[],
  topicExclusions: string = '',
): LLMMessage[] {
  const knownClusterLine =
    knownClusters.length > 0
      ? `Known cluster ids ALREADY USED in this folder (${knownClusters.length}): ${knownClusters.map((c) => `"${c}"`).join(', ')}. ALWAYS prefer one of these when a candidate fits — duplicates fragment the index. Only propose a new id when no existing one is a reasonable fit.`
      : `No clusters exist in this folder yet — propose new cluster ids based on the note's topic. Use kebab-case ASCII identifiers (e.g. "kanban-ui", "mo-chat-loop"); do not include language-specific characters.`;

  const exclusionsBlock = topicExclusions.trim().length > 0
    ? [
        '',
        "ADDITIONAL per-folder generic terms the user has marked as bad topic ids in THIS folder (do NOT propose any of these or close paraphrases):",
        topicExclusions.trim(),
      ].join('\n')
    : '';

  const system: LLMMessage = {
    role: 'system',
    content: [
      'You are an indexing assistant for a local-first notebook (Morion).',
      'You receive a single note body and emit a JSON object describing it.',
      'A note may legitimately belong to MULTIPLE clusters simultaneously — list every cluster it fits, not only the strongest match.',
      'Output JSON ONLY, no prose, no markdown fences.',
      '',
      'WHAT A TOPIC IS',
      "A topic (cluster_id) names a concrete module, location in the system, or technical implementation that the note is about. Good topic ids point at a thing a future search would look for: a feature surface (`kanban-ui`), a subsystem (`mo-chat-loop`, `import-pipeline`), a specific technology used (`tiptap`, `sqlite-vec`), an architectural seam (`mcp-surface`, `auto-code`).",
      '',
      'WHAT A TOPIC IS NOT (use note tags for these instead — do NOT propose them as cluster_ids):',
      '- Ticket lifecycle / workflow status (e.g. research, todo, doing, review, done, blocked, cancelled and any synonyms).',
      '- Environment / deployment target (e.g. development, staging, production, mobile, desktop, web, cloud).',
      '- Operating system or device family (e.g. windows, linux, macos, ios, android).',
      '- Generic code-layer descriptors (e.g. backend, frontend, ui, ux, api, database, infrastructure).',
      '- Ticket type / workflow shape (e.g. bug, feature, enhancement, story, epic, task, chore, note, data-issue).',
      'These categories describe HOW or WHERE work happens, not WHAT the note is about. Belonging to a category is a tag (one of many parallel attributes); a topic is the technical subject. If a note is "a UI bug in the Tiptap toolbar", the topic is `tiptap` (or `tiptap-toolbar`), not `ui` or `bug`.',
      '',
      'FORMAT',
      'Cluster ids are kebab-case ASCII slugs (e.g. "kanban-ui", "mo-chat-loop"). Do not include language-specific characters, spaces, or punctuation other than `-`.',
      '',
      knownClusterLine,
      exclusionsBlock,
      '',
      'Required JSON shape:',
      '{',
      '  "summary": string,                       // 1–2 plain sentences, no markdown',
      '  "keywords": string[],                    // 5–10 ASCII keywords, lowercase',
      '  "cluster_candidates": [                  // many-to-many; can be 1..5 items',
      '    { "cluster_id": string, "confidence": number }   // confidence 0..1',
      '  ]',
      '}',
    ].join('\n'),
  };

  const user: LLMMessage = {
    role: 'user',
    content: `Note body (markdown):\n\n---\n${body}\n---\n\nReturn the JSON object now. JSON ONLY.`,
  };

  return [system, user];
}

const JSON_FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

/** Parse a Tier 1 LLM response. Strips ```json fences, validates the
 *  schema, clamps confidence to [0,1], dedups cluster ids, returns
 *  `null` on any malformed input so the caller can route to the
 *  `invalid_json` failure path. */
export function parseTier1Response(raw: string): Tier1Output | null {
  if (!raw || typeof raw !== 'string') return null;
  let body = raw.trim();
  const fenceMatch = body.match(JSON_FENCE);
  if (fenceMatch) body = (fenceMatch[1] ?? '').trim();
  // Some models wrap the JSON in extra prose. Try to slice from the
  // first '{' to the matching '}' if direct parse fails.
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;
    try {
      parsed = JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : null;
  if (!summary) return null;

  const keywords: string[] = Array.isArray(obj.keywords)
    ? obj.keywords
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.trim().toLowerCase())
        .filter((k) => k.length > 0)
        .slice(0, 12)
    : [];

  const seenClusters = new Set<string>();
  const clusterCandidates: Tier1ClusterCandidate[] = [];
  if (Array.isArray(obj.cluster_candidates)) {
    for (const raw of obj.cluster_candidates) {
      if (!raw || typeof raw !== 'object') continue;
      const c = raw as Record<string, unknown>;
      const id = typeof c.cluster_id === 'string' ? c.cluster_id.trim() : null;
      if (!id || seenClusters.has(id)) continue;
      seenClusters.add(id);
      const conf =
        typeof c.confidence === 'number' && Number.isFinite(c.confidence)
          ? Math.min(1, Math.max(0, c.confidence))
          : 0.7;
      clusterCandidates.push({ clusterId: id, confidence: conf });
      if (clusterCandidates.length >= 5) break;
    }
  }

  return { summary, keywords, clusterCandidates };
}

/**
 * Run Tier 1 for a single note. Body-hash short-circuit at the top;
 * `mo_hands_off` opt-out short-circuit just below; budget pre-check
 * before the LLM call; structured-JSON parse with `'invalid_json'`
 * failure path; persistence via `metaRepo.upsert` +
 * `clustersRepo.replaceForNote(preserveUserOverrides:true)`.
 */
export async function runTier1ForNote(
  deps: Tier1RunDeps,
  noteId: string,
  options: Tier1RunOptions = {},
): Promise<Tier1RunResult> {
  const note = deps.notes.getById(noteId);
  if (!note) {
    return {
      status: 'error',
      bodyHash: null,
      reason: 'note_not_found',
      message: `note ${noteId} not found`,
    };
  }

  const body = note.body ?? '';
  const bodyHash = hashBody(body);

  // Defensive: refuse to index Mo's own system notes
  // (`mo:catalog`, `mo:cluster:*`, `mo:patrol-log`, `mo:risks`).
  // These are Mo's index storage; running Tier 1 on them creates a
  // feedback loop where the index gets indexed. The audit-enqueue +
  // bootstrap paths filter at SQL, but this guard catches manual
  // queues, forced re-runs, and any future enqueue path that forgets.
  // Ticket: 01KQKESWXPYV73V9FE614Q51HQ.
  if (note.source && note.source.startsWith('mo:')) {
    return { status: 'fresh', bodyHash, reason: 'system_note' };
  }

  const cached = deps.metaRepo.get(noteId);
  if (cached?.moHandsOff) {
    return { status: 'fresh', bodyHash, reason: 'hands_off' };
  }
  if (body.trim().length < MIN_TIER1_BODY_CHARS) {
    return { status: 'fresh', bodyHash, reason: 'empty_body' };
  }
  if (!options.force && cached?.bodyHash === bodyHash && cached.summary) {
    return { status: 'fresh', bodyHash, reason: 'hash_match' };
  }

  if (deps.budget && !deps.budget.status(options.now).withinBudget) {
    return {
      status: 'error',
      bodyHash,
      reason: 'budget_exceeded',
      message: 'Mo monthly budget exhausted; Tier 1 skipped',
    };
  }

  const messages = buildTier1Messages(
    body,
    options.knownClusters ?? [],
    options.topicExclusions ?? '',
  );
  const req: LLMRequest = {
    model: deps.model,
    messages,
    temperature: 0.1,
  };

  let response;
  try {
    response = await completeWithFallback(
      deps.provider,
      req,
      deps.fallbackModel ?? null,
    );
  } catch (err) {
    return {
      status: 'error',
      bodyHash,
      reason: 'provider_failed',
      message: (err as Error).message ?? 'provider call failed',
    };
  }

  const output = parseTier1Response(response.content ?? '');
  if (!output) {
    // Spend WAS billed by the provider — record it even on parse
    // failure so the budget cap stays honest. Skip the metadata write
    // so the next invocation retries cleanly.
    if (deps.budget && response.costUsd > 0) {
      deps.budget.record(
        spendInputFromLLMResponse({ kind: 'mo_indexing_tier1' }, response),
        options.now,
      );
    }
    return {
      status: 'error',
      bodyHash,
      reason: 'invalid_json',
      message: `Tier 1 model returned unparseable response (${(response.content ?? '').slice(0, 80)}…)`,
    };
  }

  const computedBy: MoComputedBy = options.computedBy ?? 'tier1';
  const now = options.now ?? Date.now();

  // Persist metadata + clusters in one transaction so the catalog/UI
  // never sees a partial state (summary written but cluster set
  // mid-update).
  const tx = deps.db.transaction(() => {
    deps.metaRepo.upsert(
      {
        noteId,
        summary: output.summary,
        keywords: output.keywords,
        bodyHash,
        computedBy,
        computedAt: now,
        confidence: averageConfidence(output.clusterCandidates),
      },
      now,
    );
    deps.clustersRepo.replaceForNote(
      noteId,
      output.clusterCandidates.map((c) => ({
        clusterId: c.clusterId,
        confidence: c.confidence,
        source: 'tier1' as const,
      })),
      { preserveUserOverrides: true },
      now,
    );
  });
  tx();

  // Phase 2 embedding write — runs AFTER the metadata tx commits.
  // vec0 doesn't need to be atomic with the metadata row: a missed
  // embedding self-heals on the next Tier 1 run, and the
  // `searchSimilar` JOIN against `notes` filters soft-deleted rows so
  // a stale vec entry can't surface in results either way. Both deps
  // optional — when missing (HF unavailable, vec disabled, embedder
  // returns null on transient init failure) we silently skip; metadata
  // already landed and the downstream gather path falls back to
  // keyword search. Errors here MUST NOT propagate — Tier 1 still
  // succeeded as far as the caller cares.
  if (deps.vec && deps.embeddings) {
    const embedText = buildMoMetadataEmbedText(output.summary, output.keywords);
    if (embedText !== null) {
      try {
        const vector = await deps.embeddings.embed(embedText, 'passage');
        if (vector !== null) deps.vec.upsert(noteId, vector);
      } catch {
        // Embedder transient failure — Tier 1 already wrote metadata,
        // so this note ends up in the backfill sweep on the next tick.
      }
    }
  }

  if (deps.budget && response.costUsd > 0) {
    deps.budget.record(
      spendInputFromLLMResponse({ kind: 'mo_indexing_tier1' }, response),
      now,
    );
  }

  return {
    status: 'computed',
    bodyHash,
    output,
    costUsd: response.costUsd,
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
  };
}

function averageConfidence(candidates: Tier1ClusterCandidate[]): number {
  if (candidates.length === 0) return 0;
  let sum = 0;
  for (const c of candidates) sum += c.confidence;
  return sum / candidates.length;
}
