/** Internal bootstrap state used by every later wave. Owns the
 *  cache-key inputs (taskBodyHash + folderCatalogHash) AND the
 *  baseline content shape (task body / summary / clusters /
 *  comments / audit) that gets passed through to the synthesizer.
 *  Not part of the public `WorkContextPacket` — it's the intermediate
 *  scratch used to build it. */
export interface BootstrapState {
  taskId: string | null;
  folderId: string | null;
  taskBodyHash: string | null;
  folderCatalogHash: string | null;
  clusterIds: string[];
  taskBody: string | null;
  taskTitle: string | null;
  metadataSummary: string | null;
  metadataKeywords: string[];
  comments: Array<{ actor: string; body: string; createdAt: number }>;
  audit: Array<{ action: string; actor: string; ts: number }>;
}
