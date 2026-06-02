import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type { NotesRepository } from '../notes/repository.js';
import type { FoldersRepository } from '../folders/repository.js';
import type { LLMProvider, LLMRequest, LLMMessage } from './provider.js';
import { completeWithFallback } from './provider.js';
import type { BudgetTracker } from './budget.js';
import { spendInputFromLLMResponse } from './mo-spend-ledger.js';
import type { NoteMoMetadataRepository } from './mo-metadata-repository.js';
import type { NoteMoClustersRepository } from './mo-clusters-repository.js';
import { CONCIERGE_ACTOR } from './types.js';
import {
  CATALOG_DOC_SECTIONS,
  catalogDocSkeleton,
  mergeCatalogDoc,
  parseCatalogDoc,
} from './mo-catalog-doc.js';

/**
 * Mo Indexing Redesign — Phase 4 Tier 2.5 catalog writer.
 *
 * One run per folder: gathers every cluster id assigned to notes in
 * that folder (via `note_mo_clusters` JOIN), reads each cluster's
 * aggregator note (its `overview`/`state`/`open` sections from
 * Phase 3's mo:cluster notes), feeds into the mid-tier model, merges
 * the response into the folder's `mo:catalog` note preserving any
 * user prose outside `<!-- mo:section-* -->` anchors.
 *
 * Sections written:
 *   overview — folder identity (durable across regens unless the LLM
 *              has a substantively different read of the project).
 *   clusters — the routing index: cluster id, 1-line summary, key
 *              ULIDs. This is what `mo_ask` reads to pick which
 *              clusters to live-search.
 *   recent   — recent activity / shipped work / decisions.
 *   risks    — LLM-synthesized cross-cluster risks (replaces the
 *              legacy brief `risks` section).
 *
 * Storage: regular note in the folder with source='mo:catalog' and
 * title `mo:catalog:<folder_id>` (stable lookup). Created lazily.
 */

export interface Tier25RunDeps {
  db: Database.Database;
  notes: NotesRepository;
  folders: FoldersRepository;
  metaRepo: NoteMoMetadataRepository;
  clustersRepo: NoteMoClustersRepository;
  provider: LLMProvider;
  budget?: BudgetTracker;
  model: string;
  fallbackModel?: string | null;
}

export interface Tier25RunOptions {
  /** Project memory / house style for the folder. Threaded into the
   *  system prompt verbatim. Phase 6 UI populates this from
   *  concierge_folder_settings. */
  projectMemory?: string;
  /** Override Date.now (tests). */
  now?: number;
}

export type Tier25RunResult =
  | {
      status: 'computed';
      catalogNoteId: string;
      bodyAfter: string;
      clusterCount: number;
      costUsd: number;
    }
  | {
      status: 'empty';
      reason: 'no_clusters';
    }
  | {
      status: 'error';
      reason:
        | 'folder_not_found'
        | 'budget_exceeded'
        | 'invalid_response'
        | 'provider_failed';
      message: string;
    };

const CATALOG_NOTE_SOURCE = 'mo:catalog' as const;
const CLUSTER_NOTE_SOURCE = 'mo:cluster' as const;
const CATALOG_TITLE_PREFIX = 'mo:catalog:';
const CLUSTERS_PER_FOLDER_CAP = 30;

interface ClusterSnapshot {
  clusterId: string;
  noteCount: number;
  /** Aggregator note body (mo:cluster) — pulled in for the prompt so
   *  Tier 2.5 can summarise without re-fetching every source note. */
  aggregatorBody: string;
  /** Top note ULIDs (most recent up to N) for citation in the
   *  catalog's `clusters` section. */
  noteIds: string[];
}

export function buildTier25Messages(
  folderName: string,
  clusters: ClusterSnapshot[],
  currentBody: string,
  projectMemory: string | undefined,
): LLMMessage[] {
  const clusterBlock = clusters
    .map((c) => {
      const head = `### Cluster: ${c.clusterId} (${c.noteCount} notes)`;
      const ids = c.noteIds.length > 0
        ? `Top ULIDs: ${c.noteIds.slice(0, 8).join(', ')}`
        : 'No ULIDs available.';
      const agg = c.aggregatorBody.trim().length > 0
        ? `Aggregator body:\n${c.aggregatorBody}`
        : 'Aggregator note empty (cluster not yet regenerated).';
      return [head, ids, agg].join('\n\n');
    })
    .join('\n\n---\n\n');

  const memoryBlock = projectMemory?.trim()
    ? `\n\nProject memory / house style for THIS folder (follow these conventions):\n${projectMemory.trim()}\n`
    : '';

  const system: LLMMessage = {
    role: 'system',
    content: [
      `You are maintaining the Mo Catalog note for the folder/project "${folderName}" in a local-first notebook (Morion).`,
      'You receive: per-cluster snapshots (cluster id, note count, aggregator body, top ULIDs), the CURRENT catalog body, and project memory.',
      'You output a NEW catalog body using anchored sections. Sections inside <!-- mo:section-start id="..." --> markers are yours to regenerate; everything outside is user-owned and you must NOT touch it.',
      '',
      'Required sections (output ALL four anchors, even if a section is unchanged — leave its content empty to keep the prior version):',
      '  overview — durable folder/project identity (1-3 sentences). Stable across regens unless the project itself shifted.',
      '  clusters — the routing index. One bullet per cluster: `- <cluster-id> (N notes) — 1-line summary. ULIDs: 01ABC, 01DEF`. This is what agents read to decide where to search.',
      '  recent   — what shipped / what changed / which decisions landed since the last regen.',
      '  risks    — cross-cluster risks: stuck initiatives, contradicting decisions, P1 tickets sitting too long.',
      '',
      'Cite ULIDs from the supplied cluster snapshots. Do NOT invent new ULIDs.',
      'Output the full markdown body, NOT diffs. JSON-fenced output is forbidden — output raw markdown.',
      memoryBlock,
    ].join('\n'),
  };

  const user: LLMMessage = {
    role: 'user',
    content:
      `Folder: ${folderName}\n\n` +
      `Clusters (${clusters.length}):\n\n${clusterBlock || '(none)'}\n\n` +
      `Current catalog body:\n---\n${currentBody}\n---\n\n` +
      `Return the full updated catalog body now.`,
  };

  return [system, user];
}

export function findCatalogNoteId(
  db: Database.Database,
  folderId: string,
): string | null {
  const expectedTitle = `${CATALOG_TITLE_PREFIX}${folderId}`;
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
    .get(folderId, CATALOG_NOTE_SOURCE, expectedTitle);
  return row?.id ?? null;
}

export function ensureCatalogNote(
  db: Database.Database,
  folderId: string,
  folderName: string,
  now: number = Date.now(),
): { id: string; created: boolean; body: string } {
  const existing = findCatalogNoteId(db, folderId);
  if (existing) {
    const row = db
      .prepare<[string], { body: string }>(
        'SELECT body FROM notes WHERE id = ?',
      )
      .get(existing);
    return { id: existing, created: false, body: row?.body ?? '' };
  }
  const id = ulid();
  const title = `${CATALOG_TITLE_PREFIX}${folderId}`;
  const body = catalogDocSkeleton(folderName);
  db.prepare(
    `INSERT INTO notes
       (id, folder_id, title, body, pinned, source, created_at, updated_at,
        deleted_at, status, position)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL, 'note', NULL)`,
  ).run(id, folderId, title, body, CATALOG_NOTE_SOURCE, now, now);
  db.prepare(
    `INSERT INTO audit_log (note_id, action, actor, ts)
     VALUES (?, ?, ?, ?)`,
  ).run(id, 'create', CONCIERGE_ACTOR, now);
  return { id, created: true, body };
}

/** Snapshot every cluster in a folder along with its aggregator body
 *  + top ULIDs. Pure read — no LLM. Used by the Tier 2.5 runner and
 *  by `mo_list_clusters` / `mo_get_cluster` when those primitives
 *  need cluster routing data without an LLM call. */
export function snapshotFolderClusters(
  db: Database.Database,
  folderId: string,
): ClusterSnapshot[] {
  const clusterRows = db
    .prepare<[string, number], { cluster_id: string; n: number }>(
      `SELECT nmc.cluster_id, COUNT(*) AS n
         FROM note_mo_clusters nmc
         JOIN notes n ON n.id = nmc.note_id
        WHERE n.folder_id = ?
          AND n.deleted_at IS NULL
          AND n.archived_at IS NULL
          AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
        GROUP BY nmc.cluster_id
        ORDER BY n DESC
        LIMIT ?`,
    )
    .all(folderId, CLUSTERS_PER_FOLDER_CAP);

  const snapshots: ClusterSnapshot[] = [];
  for (const r of clusterRows) {
    const aggregator = db
      .prepare<[string, string, string], { body: string }>(
        `SELECT body FROM notes
          WHERE folder_id = ? AND source = ? AND title = ?
            AND deleted_at IS NULL
          LIMIT 1`,
      )
      .get(folderId, CLUSTER_NOTE_SOURCE, `mo:cluster:${r.cluster_id}`);

    const ids = db
      .prepare<[string, string, number], { id: string }>(
        `SELECT n.id FROM note_mo_clusters nmc
           JOIN notes n ON n.id = nmc.note_id
          WHERE nmc.cluster_id = ?
            AND n.folder_id = ?
            AND n.deleted_at IS NULL
            AND n.archived_at IS NULL
            AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
          ORDER BY n.updated_at DESC
          LIMIT ?`,
      )
      .all(r.cluster_id, folderId, 8)
      .map((row) => row.id);

    snapshots.push({
      clusterId: r.cluster_id,
      noteCount: r.n,
      aggregatorBody: aggregator?.body ?? '',
      noteIds: ids,
    });
  }
  return snapshots;
}

export async function runTier25ForFolder(
  deps: Tier25RunDeps,
  folderId: string,
  options: Tier25RunOptions = {},
): Promise<Tier25RunResult> {
  const folder = deps.folders.getById(folderId);
  if (!folder) {
    return {
      status: 'error',
      reason: 'folder_not_found',
      message: `folder ${folderId} not found`,
    };
  }

  const clusters = snapshotFolderClusters(deps.db, folderId);
  if (clusters.length === 0) {
    return { status: 'empty', reason: 'no_clusters' };
  }

  if (deps.budget && !deps.budget.status(options.now).withinBudget) {
    return {
      status: 'error',
      reason: 'budget_exceeded',
      message: 'Mo monthly budget exhausted; Tier 2.5 skipped',
    };
  }

  const now = options.now ?? Date.now();
  const ensured = ensureCatalogNote(deps.db, folderId, folder.name, now);

  const messages = buildTier25Messages(
    folder.name,
    clusters,
    ensured.body,
    options.projectMemory,
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
      deps.budget.record(spendInputFromLLMResponse({ kind: 'mo_indexing_catalog' }, response), now);
    }
    return {
      status: 'error',
      reason: 'invalid_response',
      message: 'Tier 2.5 model returned empty content',
    };
  }

  const llmParsed = parseCatalogDoc(llmText);
  const llmHadAnyAnchorContent = CATALOG_DOC_SECTIONS.some(
    (id) => llmParsed.sections[id].trim().length > 0,
  );
  if (!llmHadAnyAnchorContent) {
    if (deps.budget && response.costUsd > 0) {
      deps.budget.record(spendInputFromLLMResponse({ kind: 'mo_indexing_catalog' }, response), now);
    }
    return {
      status: 'error',
      reason: 'invalid_response',
      message: 'Tier 2.5 response did not include any anchored sections',
    };
  }
  const merged = mergeCatalogDoc(ensured.body, llmText, folder.name);

  const tx = deps.db.transaction(() => {
    deps.db
      .prepare(
        `UPDATE notes SET body = ?, title = ?, updated_at = ? WHERE id = ?`,
      )
      .run(merged, `${CATALOG_TITLE_PREFIX}${folderId}`, now, ensured.id);
    deps.db
      .prepare(
        `INSERT INTO audit_log (note_id, action, actor, ts)
         VALUES (?, ?, ?, ?)`,
      )
      .run(ensured.id, 'update', CONCIERGE_ACTOR, now);
  });
  tx();

  if (deps.budget && response.costUsd > 0) {
    deps.budget.record(spendInputFromLLMResponse({ kind: 'mo_indexing_catalog' }, response), now);
  }

  return {
    status: 'computed',
    catalogNoteId: ensured.id,
    bodyAfter: merged,
    clusterCount: clusters.length,
    costUsd: response.costUsd,
  };
}
