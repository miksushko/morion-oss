import type Database from 'better-sqlite3';
import {
  TOPIC_HYGIENE_MAX_CLUSTERS,
  type ClusterPanoramaItem,
} from './types.js';

interface PanoramaRow {
  cluster_id: string;
  note_count: number;
  has_user_pin: number;
  sample_titles: string;
}

/** Pull the cluster panorama for one folder. Single SQL with two
 *  GROUP_CONCAT'd subqueries — keeps it cheap on folders with hundreds
 *  of clusters. Returns at most `TOPIC_HYGIENE_MAX_CLUSTERS` items;
 *  bigger folders are out of scope for one LLM pass and need a future
 *  paginated mode (deferred). */
export function gatherClusterPanorama(
  db: Database.Database,
  folderId: string,
  cap: number = TOPIC_HYGIENE_MAX_CLUSTERS,
): ClusterPanoramaItem[] {
  // GROUP_CONCAT in SQLite has an undefined order without a subquery
  // ORDER BY; we get newest titles by joining on a windowed subquery.
  // Simpler shape: one query for the count + pin flag, a per-cluster
  // follow-up for sample titles. Per-cluster N+1 is fine — folders
  // with 376 clusters do 377 quick reads, sub-millisecond each.
  const counts = db
    .prepare<[string, number], PanoramaRow>(
      `SELECT
         nmc.cluster_id,
         COUNT(*) AS note_count,
         MAX(CASE WHEN nmc.source = 'user' THEN 1 ELSE 0 END) AS has_user_pin,
         '' AS sample_titles
       FROM note_mo_clusters nmc
       JOIN notes n ON n.id = nmc.note_id
      WHERE n.folder_id = ?
        AND n.deleted_at IS NULL
        AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
      GROUP BY nmc.cluster_id
      ORDER BY note_count DESC, nmc.cluster_id ASC
      LIMIT ?`,
    )
    .all(folderId, cap);

  const titleStmt = db.prepare<[string, string, number], { title: string }>(
    `SELECT n.title
       FROM note_mo_clusters nmc
       JOIN notes n ON n.id = nmc.note_id
      WHERE nmc.cluster_id = ?
        AND n.folder_id = ?
        AND n.deleted_at IS NULL
        AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
      ORDER BY n.updated_at DESC
      LIMIT ?`,
  );

  return counts.map((row) => {
    const titles = titleStmt
      .all(row.cluster_id, folderId, 5)
      .map((t) => t.title)
      .filter((t) => t && t.length > 0);
    return {
      clusterId: row.cluster_id,
      noteCount: row.note_count,
      sampleTitles: titles,
      hasUserPin: row.has_user_pin === 1,
    };
  });
}
