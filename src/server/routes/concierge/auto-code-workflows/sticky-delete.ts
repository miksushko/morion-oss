/**
 * DELETE /api/auto-code/workflows/:id sticky-delete bookkeeping.
 *
 * Extracted from `../auto-code-workflows.ts` so the route file stays
 * lean. When a user deletes a workflow row that originated from a
 * seeded template, we mark the template id as "sticky-deleted" in the
 * folder's `auto_code.seeded_templates.<folderId>` tracker so the next
 * GET /workflows doesn't re-seed it. Provenance entry is dropped so a
 * later create can't reuse the same id to re-sticky-suppress.
 */

import type { SettingsRepository } from '../../../../core/settings/repository.js';

export function recordStickyDeleteForRow(
  settings: SettingsRepository,
  folderId: string,
  deletedRowId: string,
): void {
  const trackerKey = `auto_code.seeded_templates.${folderId}`;
  const provenanceKey = `auto_code.seeded_row_provenance.${folderId}`;
  const provenanceRaw = settings.get<string>(provenanceKey, '');
  let provenance: Record<string, string> = {};
  try {
    provenance = provenanceRaw ? JSON.parse(provenanceRaw) : {};
    if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) {
      provenance = {};
    }
  } catch {
    provenance = {};
  }
  const matchedTemplateId = provenance[deletedRowId];
  if (!matchedTemplateId) return;

  const seededRaw = settings.get<string>(trackerKey, '');
  const seededSet = new Set(
    (seededRaw || '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  seededSet.add(matchedTemplateId);
  settings.set(trackerKey, Array.from(seededSet).join(','));
  // Drop the provenance entry so the row id can't keep
  // sticky-suppressing if a future create reuses it.
  delete provenance[deletedRowId];
  settings.set(provenanceKey, JSON.stringify(provenance));
}
