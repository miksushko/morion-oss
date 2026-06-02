/**
 * Resolve the per-folder `mo:catalog` body for folder-scoped chat. Extracted
 * from `../shared.ts` (2026-05-16, ticket `01KRQYS1T925XEWBBJJYRJBGE2`).
 */

import { findCatalogNoteId } from '../../../../core/concierge/mo-tier25.js';
import type { ToolContext } from '../../../tools/types.js';

/**
 * Mo Indexing Redesign — resolve the per-folder `mo:catalog` body for
 * folder-scoped chat. The catalog is the routing index Tier 2.5
 * regenerates after each Tier 2 cluster pass; injected into the chat
 * system prompt so Mo can scope live searches without first calling
 * a separate cluster-list primitive. Returns null when Mo is disabled
 * for the folder OR the catalog hasn't been built yet (folder freshly
 * enabled, no indexing tick has run).
 */
export function resolveProjectCatalog(
  folderId: string,
  ctx: ToolContext,
  bag: NonNullable<ToolContext['concierge']>,
): string | null {
  const settings = bag.folderSettings.getOrDefault(folderId);
  if (!settings.enabled) return null;
  const catalogNoteId = findCatalogNoteId(ctx.db, folderId);
  if (!catalogNoteId) return null;
  const note = ctx.notes.getById(catalogNoteId);
  if (!note?.body.trim()) return null;
  return note.body;
}
