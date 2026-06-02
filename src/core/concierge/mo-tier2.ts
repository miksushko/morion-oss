import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type { NotesRepository } from '../notes/repository.js';
import type { LLMProvider, LLMRequest, LLMMessage } from './provider.js';
import { completeWithFallback } from './provider.js';
import type { BudgetTracker } from './budget.js';
import { spendInputFromLLMResponse } from './mo-spend-ledger.js';
import type { NoteMoMetadataRepository } from './mo-metadata-repository.js';
import type { NoteMoClustersRepository } from './mo-clusters-repository.js';
import { CONCIERGE_ACTOR } from './types.js';
import {
  CLUSTER_DOC_SECTIONS,
  clusterDocSkeleton,
  mergeClusterDoc,
  parseClusterDoc,
} from './mo-cluster-doc.js';

/**
 * Mo Indexing Redesign — Phase 3 Tier 2 cluster aggregator regen.
 *
 * For one cluster id in one folder: gather every note assigned to it
 * (via `note_mo_clusters` JOIN) plus those notes' Tier 1 summaries
 * (from `note_mo_metadata`), feed into the mid-tier model, merge the
 * response into the existing `mo:cluster:<theme>` aggregator note
 * preserving any user prose outside `<!-- mo:section-* -->` anchors.
 *
 * Lazy-creates the aggregator note on first regen with source
 * `mo:cluster` and an empty skeleton; subsequent regens update via
 * `mergeClusterDoc`.
 *
 * Spend kind: `mo_tool` (same bucket as Tier 1 — a dedicated
 * `'patrol'` breakdown is deferred until the schema enum is widened).
 *
 * Skips:
 *   - cluster has zero notes assigned (caller should clear the queue
 *     row; Phase 3b drainer treats this as `empty`).
 *   - cluster's notes all lack a Tier 1 summary (regen would have
 *     nothing substantive to feed; treat as `not_ready`).
 *   - budget exhausted before the call — `budget_exceeded` envelope.
 *   - LLM response unparseable / empty — `invalid_response` envelope.
 */

export interface Tier2RunDeps {
  db: Database.Database;
  notes: NotesRepository;
  metaRepo: NoteMoMetadataRepository;
  clustersRepo: NoteMoClustersRepository;
  provider: LLMProvider;
  budget?: BudgetTracker;
  model: string;
  fallbackModel?: string | null;
}

export interface Tier2RunOptions {
  /** Per-cluster house style / pointers from folder settings (Phase 6
   *  Tasks Topics tab). Threaded into the system prompt verbatim so
   *  Mo follows whatever convention the user set. */
  houseRules?: string;
  /** Force re-render even if no notes have changed. Default false. */
  force?: boolean;
  /** Override Date.now (tests). */
  now?: number;
}

export type Tier2RunResult =
  | {
      status: 'computed';
      clusterNoteId: string;
      bodyAfter: string;
      noteCount: number;
      costUsd: number;
    }
  | {
      status: 'empty';
      reason: 'no_notes' | 'not_ready';
    }
  | {
      status: 'error';
      reason: 'budget_exceeded' | 'invalid_response' | 'provider_failed';
      message: string;
    };

const CLUSTER_NOTE_SOURCE = 'mo:cluster' as const;
const CLUSTER_TITLE_PREFIX = 'mo:cluster:';
const NOTES_PER_CLUSTER_CAP = 40;

/** Pure prompt builder. Tests pin the wire shape so a future model
 *  swap doesn't drift it silently. */
export function buildTier2Messages(
  clusterId: string,
  notes: Array<{ id: string; title: string; summary: string; keywords: string[] }>,
  currentBody: string,
  houseRules: string | undefined,
): LLMMessage[] {
  const noteList = notes
    .map((n) => {
      const kw = n.keywords.length > 0 ? ` [${n.keywords.join(', ')}]` : '';
      return `- ${n.id} — ${n.title}${kw}\n  ${n.summary}`;
    })
    .join('\n');

  const houseRulesBlock = houseRules?.trim()
    ? `\n\nHouse rules from the user (follow these for THIS cluster):\n${houseRules.trim()}\n`
    : '';

  const system: LLMMessage = {
    role: 'system',
    content: [
      `You are maintaining a cluster aggregator note for the topic "${clusterId}" in a local-first notebook (Morion).`,
      'You receive: a list of source notes assigned to this cluster (with their Tier 1 summaries), the CURRENT aggregator body, and house rules from the user.',
      'You output a NEW aggregator body using anchored sections. Sections inside <!-- mo:section-start id="..." --> markers are yours to regenerate; everything outside is user-owned and you must NOT touch it.',
      '',
      'Required sections (output ALL four anchors, even if a section is unchanged — leave its content empty to keep the prior version):',
      '  overview — what this cluster IS (1-2 plain sentences, durable across regens)',
      '  state    — current state: counts (open/done/in-progress), recent activity, key decisions',
      '  open     — what is open / blocked / next priority',
      '  notes    — bulleted index of source ULIDs cited above (e.g. "- 01ABC… title")',
      '',
      'Cite ULIDs from the supplied note list. Do NOT invent new ULIDs.',
      'Output the full markdown body, NOT diffs. JSON-fenced output is forbidden — output raw markdown.',
      houseRulesBlock,
    ].join('\n'),
  };

  const user: LLMMessage = {
    role: 'user',
    content:
      `Cluster: ${clusterId}\n\n` +
      `Source notes (${notes.length}):\n${noteList || '(none)'}\n\n` +
      `Current aggregator body:\n---\n${currentBody}\n---\n\n` +
      `Return the full updated aggregator body now.`,
  };

  return [system, user];
}

/** Find the existing `mo:cluster` aggregator note for a cluster id in
 *  a folder, or null. Lookup is by `(folder_id, source, title prefix)`
 *  — title is `mo:cluster:<id>` so matches are exact. */
export function findClusterNoteId(
  db: Database.Database,
  folderId: string,
  clusterId: string,
): string | null {
  const expectedPrefix = `${CLUSTER_TITLE_PREFIX}${clusterId}`;
  const row = db
    .prepare<[string, string, string], { id: string }>(
      `SELECT id FROM notes
        WHERE folder_id = ?
          AND source = ?
          AND deleted_at IS NULL
          AND title = ?
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .get(folderId, CLUSTER_NOTE_SOURCE, expectedPrefix);
  return row?.id ?? null;
}

/** Lazy-create the aggregator note for a cluster. Idempotent — second
 *  call returns the existing id. Uses direct INSERT (not
 *  NotesRepository.create) so we can set the `mo:cluster` source +
 *  exact title without going through the public schema. */
export function ensureClusterNote(
  db: Database.Database,
  folderId: string,
  clusterId: string,
  now: number = Date.now(),
): { id: string; created: boolean; body: string } {
  const existing = findClusterNoteId(db, folderId, clusterId);
  if (existing) {
    const row = db
      .prepare<[string], { body: string }>(
        'SELECT body FROM notes WHERE id = ?',
      )
      .get(existing);
    return { id: existing, created: false, body: row?.body ?? '' };
  }
  const id = ulid();
  const title = `${CLUSTER_TITLE_PREFIX}${clusterId}`;
  const body = clusterDocSkeleton(clusterId);
  db.prepare(
    `INSERT INTO notes
       (id, folder_id, title, body, pinned, source, created_at, updated_at,
        deleted_at, status, position)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL, 'note', NULL)`,
  ).run(id, folderId, title, body, CLUSTER_NOTE_SOURCE, now, now);
  db.prepare(
    `INSERT INTO audit_log (note_id, action, actor, ts)
     VALUES (?, ?, ?, ?)`,
  ).run(id, 'create', CONCIERGE_ACTOR, now);
  return { id, created: true, body };
}

/**
 * Run Tier 2 for a single cluster in a folder. Gathers notes via
 * `note_mo_clusters` JOIN, calls the LLM, merges into the aggregator
 * note. Returns a discriminated union describing the outcome.
 */
export async function runTier2ForCluster(
  deps: Tier2RunDeps,
  folderId: string,
  clusterId: string,
  options: Tier2RunOptions = {},
): Promise<Tier2RunResult> {
  const now = options.now ?? Date.now();

  // Gather every note assigned to this cluster + its Tier 1 metadata.
  const noteRows = deps.db
    .prepare<[string, string], { id: string; body: string }>(
      `SELECT n.id, n.body
         FROM note_mo_clusters nmc
         JOIN notes n ON n.id = nmc.note_id
        WHERE nmc.cluster_id = ?
          AND n.folder_id = ?
          AND n.deleted_at IS NULL
          AND n.archived_at IS NULL
          AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
        ORDER BY n.updated_at DESC
        LIMIT ${NOTES_PER_CLUSTER_CAP}`,
    )
    .all(clusterId, folderId);

  if (noteRows.length === 0) {
    return { status: 'empty', reason: 'no_notes' };
  }

  const notes: Array<{
    id: string;
    title: string;
    summary: string;
    keywords: string[];
  }> = [];
  for (const row of noteRows) {
    const meta = deps.metaRepo.get(row.id);
    if (!meta || !meta.summary) continue;
    notes.push({
      id: row.id,
      title: deriveDisplayTitle(row.body),
      summary: meta.summary,
      keywords: meta.keywords ?? [],
    });
  }
  if (notes.length === 0) {
    return { status: 'empty', reason: 'not_ready' };
  }

  if (deps.budget && !deps.budget.status(options.now).withinBudget) {
    return {
      status: 'error',
      reason: 'budget_exceeded',
      message: 'Mo monthly budget exhausted; Tier 2 skipped',
    };
  }

  const ensured = ensureClusterNote(deps.db, folderId, clusterId, now);
  const messages = buildTier2Messages(
    clusterId,
    notes,
    ensured.body,
    options.houseRules,
  );

  const req: LLMRequest = {
    model: deps.model,
    messages,
    temperature: 0.2,
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
      reason: 'provider_failed',
      message: (err as Error).message ?? 'provider call failed',
    };
  }

  const llmText = (response.content ?? '').trim();
  if (llmText.length === 0) {
    if (deps.budget && response.costUsd > 0) {
      deps.budget.record(spendInputFromLLMResponse({ kind: 'mo_indexing_tier2' }, response), now);
    }
    return {
      status: 'error',
      reason: 'invalid_response',
      message: 'Tier 2 model returned empty content',
    };
  }

  // Detect whether the LLM emitted any anchored section content.
  // String equality of merged === current isn't reliable because
  // `renderClusterDoc` normalizes whitespace; the parse-level check
  // is precise.
  const llmParsed = parseClusterDoc(llmText);
  const llmHadAnyAnchorContent = CLUSTER_DOC_SECTIONS.some(
    (id) => llmParsed.sections[id].trim().length > 0,
  );
  if (!llmHadAnyAnchorContent) {
    if (deps.budget && response.costUsd > 0) {
      deps.budget.record(spendInputFromLLMResponse({ kind: 'mo_indexing_tier2' }, response), now);
    }
    return {
      status: 'error',
      reason: 'invalid_response',
      message: 'Tier 2 response did not include any anchored sections',
    };
  }
  const merged = mergeClusterDoc(ensured.body, llmText, clusterId);

  // Persist: update the aggregator note body and append an audit row.
  const tx = deps.db.transaction(() => {
    deps.db
      .prepare(
        `UPDATE notes SET body = ?, title = ?, updated_at = ? WHERE id = ?`,
      )
      .run(merged, `${CLUSTER_TITLE_PREFIX}${clusterId}`, now, ensured.id);
    deps.db
      .prepare(
        `INSERT INTO audit_log (note_id, action, actor, ts)
         VALUES (?, ?, ?, ?)`,
      )
      .run(ensured.id, 'update', CONCIERGE_ACTOR, now);
  });
  tx();

  if (deps.budget && response.costUsd > 0) {
    deps.budget.record(spendInputFromLLMResponse({ kind: 'mo_indexing_tier2' }, response), now);
  }

  return {
    status: 'computed',
    clusterNoteId: ensured.id,
    bodyAfter: merged,
    noteCount: notes.length,
    costUsd: response.costUsd,
  };
}

/** Pull the first non-empty body line, strip leading markdown
 *  markers, truncate to 80 chars. Mirrors the project-wide title
 *  derivation so cluster-doc display titles match what notes_search
 *  returns. */
function deriveDisplayTitle(body: string): string {
  for (const raw of body.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const cleaned = trimmed.replace(/^[#\-*\s>]+/, '').trim();
    if (cleaned.length === 0) continue;
    return cleaned.length > 80 ? cleaned.slice(0, 77) + '...' : cleaned;
  }
  return '(untitled)';
}
