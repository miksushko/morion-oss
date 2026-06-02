import { catalogDocHasContent } from '../mo-catalog-doc.js';
import { STALE_CATALOG_MS, type MoIndexingTickDeps } from './internals.js';

/**
 * Step 4 — compute the set of folders that need a Tier 2.5
 * (mo:catalog) regen this tick. Original v1: just folders that had
 * a same-tick Tier 2 success. That left catalog stuck stale
 * whenever Tier 2 finished a cluster in tick N but Tier 2.5 ran on
 * tick N+1 with no new Tier 2 completions.
 *
 * Self-recovery v2 unions the same-tick set with three other paths
 * so the catalog always converges:
 *
 *   (a) Folders with at least one mo:cluster:* note built but NO
 *       catalog yet — first-time generation catch-up.
 *   (b) Folders whose catalog body is still the skeleton (every
 *       section is the placeholder copy from `catalogDocSkeleton`).
 *       Means a previous Tier 2.5 attempt errored, returned `empty`
 *       / `not_ready`, OR the bootstrap ran but its LLM call failed
 *       mid-flight. Fires every tick until the LLM call succeeds —
 *       no age throttle, no recurring cost once content lands.
 *   (c) Folders whose catalog has content but the cluster set has
 *       MOVED since the catalog was last written
 *       (`max(note_mo_clusters.updated_at) > catalog.updated_at`),
 *       AND that move is at least `STALE_CATALOG_MS` old. Throttle
 *       keeps recurring spend bounded; cluster-moved gate avoids
 *       regen-spinning when nothing actually changed.
 */
interface CatalogRow {
  folder_id: string;
  body: string;
  catalog_updated_at: number;
  max_cluster_updated_at: number | null;
  has_clusters: number;
}

export function collectTier25Folders(
  deps: MoIndexingTickDeps,
  sameTickFolders: readonly string[],
  now: number,
): Set<string> {
  const tier25Folders = new Set<string>(sameTickFolders);

  const catalogRows = deps.db
    .prepare<[string], CatalogRow>(
      `SELECT n.folder_id                         AS folder_id,
              n.body                              AS body,
              n.updated_at                        AS catalog_updated_at,
              (SELECT MAX(nc.updated_at) FROM note_mo_clusters nc
                 JOIN notes n2 ON n2.id = nc.note_id
                WHERE n2.folder_id = n.folder_id
                  AND n2.deleted_at IS NULL)      AS max_cluster_updated_at,
              (SELECT COUNT(*) FROM note_mo_clusters nc
                 JOIN notes n2 ON n2.id = nc.note_id
                WHERE n2.folder_id = n.folder_id
                  AND n2.deleted_at IS NULL)      AS has_clusters
         FROM notes n
         JOIN concierge_folder_settings cfs ON cfs.folder_id = n.folder_id
        WHERE n.source = ?
          AND n.deleted_at IS NULL
          AND cfs.enabled = 1`,
    )
    .all('mo:catalog');
  for (const row of catalogRows) {
    if (row.has_clusters === 0) continue; // nothing to summarise
    if (!catalogDocHasContent(row.body)) {
      // (b) skeleton-only body → previous Tier 2.5 didn't land real
      //     content. Retry on every tick until it sticks.
      tier25Folders.add(row.folder_id);
      continue;
    }
    if (
      row.max_cluster_updated_at !== null &&
      row.max_cluster_updated_at > row.catalog_updated_at &&
      now - row.catalog_updated_at >= STALE_CATALOG_MS
    ) {
      // (c) clusters moved since last write AND catalog is at least
      //     30 min old.
      tier25Folders.add(row.folder_id);
    }
  }
  // (a) bootstrap catch-up — folders with mo:cluster notes but no
  //     catalog yet.
  const noCatalogFolders = deps.db
    .prepare<[string, string], { folder_id: string }>(
      `SELECT DISTINCT cl.folder_id AS folder_id
         FROM notes cl
         JOIN concierge_folder_settings cfs ON cfs.folder_id = cl.folder_id
        WHERE cl.source = ?
          AND cl.deleted_at IS NULL
          AND cfs.enabled = 1
          AND NOT EXISTS (
            SELECT 1 FROM notes c
            WHERE c.folder_id = cl.folder_id
              AND c.source = ?
              AND c.deleted_at IS NULL
          )`,
    )
    .all('mo:cluster', 'mo:catalog')
    .map((r) => r.folder_id);
  for (const id of noCatalogFolders) tier25Folders.add(id);
  return tier25Folders;
}
