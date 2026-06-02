/**
 * GET /api/auto-code/workflows pre-seed purge + heal logic.
 *
 * Extracted from `../auto-code-workflows.ts` so the route file stays
 * focused on Hono handlers. Pure data-transform over a snapshot of
 * the folder's workflow rows + the seed-tracker / provenance settings
 * — every mutation is performed through the passed-in `WorkflowsRepository`
 * and `SettingsRepository`; no Hono dependency.
 *
 * Composed of five paths that all run inside the GET /workflows handler
 * before `seedDefaultsForFolder`:
 *
 *   (1) Provenance-based legacy purge — rows whose tracked templateId
 *       no longer appears in the current registry.
 *   (2) Name + shape based purge — pre-provenance seeds; matches by
 *       legacy registry label AND lack of v2 stage kinds.
 *   (3) Outdated v2-seed in-place refresh — keeps ULID stable so cached
 *       UI ids stay valid. Skips rows the user has edited
 *       (`updated_at > created_at`).
 *   (4) Schema-invalid hard purge — Zod-failing rows that `listForFolder`
 *       silently skips but the raw sidebar shows then 404s on click.
 *   (5) Provenance / tracker heal — drops entries pointing at rows that
 *       no longer exist so seedDefaults can re-insert.
 *
 * Plus one terminal step: heal a stale `workflow_template` setting
 * pointing at a deleted ULID (path 5b).
 */

import type Database from 'better-sqlite3';
import type { SettingsRepository } from '../../../../core/settings/repository.js';
import { isDraftWorkflowDefinition } from '../../../../core/auto-code/workflows/parse-linear.js';
import {
  DEFAULT_TEMPLATE_ID,
  listWorkflowTemplates,
} from '../../../../core/auto-code/workflows/templates.js';
import type { WorkflowsRepository } from '../../../../core/auto-code/workflows/workflows-repository.js';
import { WorkflowDefinitionSchema } from '../../../../core/auto-code/workflows/types/index.js';
import {
  readFolderWorkflowTemplate,
  writeFolderWorkflowTemplate,
} from '../../../features/auto-code-template-settings.js';

const LEGACY_REGISTRY_LABELS = new Set<string>([
  'Default (Claude → Codex review)',
  'Bug fix',
  'Claude solo (no review)',
  'Docs only',
  'Feature with planning',
  'PI fix + Codex review',
  'Spike / research',
]);

export interface PurgeDeps {
  db: Database.Database;
  settings: SettingsRepository;
  repo: WorkflowsRepository;
  folderId: string;
}

export interface PurgeResult {
  /** Caller passes this map straight into the seedDefaults provenance
   *  recorder so the post-purge state is preserved. */
  seededSet: Set<string>;
  /** Caller writes this back to settings + uses for the post-seed
   *  workflow_template alignment migration. */
  provenance: Record<string, string>;
  /** Set of row ULIDs deleted across all five paths. */
  purgedRowIds: Set<string>;
  /** True when one of the deletions targeted the row currently active
   *  in `workflow_template.<folderId>`. */
  activeSelectionDeleted: boolean;
  /** Final snapshot of folder rows after purge — passed back so the
   *  heal step doesn't re-query. */
  rowsAfterPurge: Set<string>;
}

export function purgeLegacyAndHeal(deps: PurgeDeps): PurgeResult {
  const { db, settings, repo, folderId } = deps;
  const trackerKey = `auto_code.seeded_templates.${folderId}`;
  const provenanceKey = `auto_code.seeded_row_provenance.${folderId}`;

  const seededRaw = settings.get<string>(trackerKey, '');
  const seededSet = new Set(
    (seededRaw || '').split(',').map((s) => s.trim()).filter(Boolean),
  );
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

  const currentRegistryIds = new Set(listWorkflowTemplates().map((t) => t.id));
  const activeSelectionBefore = readFolderWorkflowTemplate(settings, folderId);
  let activeSelectionDeleted = false;
  const purgedRowIds = new Set<string>();

  // Path (1): provenance-based.
  for (const [rowId, templateId] of Object.entries(provenance)) {
    if (currentRegistryIds.has(templateId)) continue;
    const deleted = repo.delete(rowId);
    if (deleted) {
      purgedRowIds.add(rowId);
      if (activeSelectionBefore === rowId) activeSelectionDeleted = true;
    }
    delete provenance[rowId];
    seededSet.delete(templateId);
  }

  // Path (2): name + shape based — catches pre-provenance seeds.
  for (const row of repo.listForFolder(folderId)) {
    if (purgedRowIds.has(row.id)) continue;
    if (!LEGACY_REGISTRY_LABELS.has(row.name)) continue;
    const hasV2Kind = row.definition.stages.some(
      (s) =>
        s.kind === 'mo_stage' ||
        s.kind === 'reject_sink' ||
        s.kind === 'complete_sink',
    );
    if (hasV2Kind) continue; // user-authored v2 sharing legacy label
    const deleted = repo.delete(row.id);
    if (deleted) {
      purgedRowIds.add(row.id);
      if (activeSelectionBefore === row.id) activeSelectionDeleted = true;
    }
  }

  // Path (3): outdated v2-seed REFRESH in-place.
  const registryByIdMap = new Map(
    listWorkflowTemplates().map((t) => [t.id, t]),
  );
  const folderRowsByIdMap = new Map(
    repo.listForFolder(folderId).map((r) => [r.id, r]),
  );
  for (const [rowId, templateId] of Object.entries(provenance)) {
    if (purgedRowIds.has(rowId)) continue;
    const tpl = registryByIdMap.get(templateId);
    if (!tpl) continue;
    const row = folderRowsByIdMap.get(rowId);
    if (!row) continue;
    // CRITICAL (2026-05-11 user report): skip rows the user has edited.
    // seedDefaultsForFolder inserts with updated_at === created_at; the
    // first refresh bumps updated_at; any user save also bumps
    // updated_at. So `updated_at > created_at` is the sentinel for
    // "this row has been touched, leave it alone".
    if (row.updatedAt > row.createdAt) continue;
    const rowStageIds = new Set(row.definition.stages.map((s) => s.id));
    const tplStageIds = new Set(tpl.definition.stages.map((s) => s.id));
    const stageIdsMatch =
      rowStageIds.size === tplStageIds.size &&
      [...tplStageIds].every((id) => rowStageIds.has(id));
    if (stageIdsMatch) continue;
    try {
      repo.update(rowId, {
        name: tpl.label,
        definition: tpl.definition,
      });
    } catch {
      // Parse failure on the registry definition (shouldn't happen) —
      // leave the stale row alone rather than corrupting it.
    }
  }

  // Path (3.5): hard purge of schema-invalid rows.
  const allRowIdsInDb = db
    .prepare(
      `SELECT id, definition_json FROM workflows WHERE folder_id = ?`,
    )
    .all(folderId) as Array<{ id: string; definition_json: string }>;
  for (const r of allRowIdsInDb) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.definition_json);
    } catch {
      repo.delete(r.id);
      if (activeSelectionBefore === r.id) activeSelectionDeleted = true;
      purgedRowIds.add(r.id);
      for (const [pId, tId] of Object.entries(provenance)) {
        if (pId === r.id) {
          delete provenance[pId];
          seededSet.delete(tId);
        }
      }
      continue;
    }
    const result = WorkflowDefinitionSchema.safeParse(parsed);
    if (result.success) continue;
    repo.delete(r.id);
    if (activeSelectionBefore === r.id) activeSelectionDeleted = true;
    purgedRowIds.add(r.id);
    for (const [pId, tId] of Object.entries(provenance)) {
      if (pId === r.id) {
        delete provenance[pId];
        seededSet.delete(tId);
      }
    }
  }

  // Path (4): heal stale provenance / tracker entries.
  const rowsAfterPurge = new Set(
    repo.listForFolder(folderId).map((r) => r.id),
  );
  let healedAny = false;
  for (const [rowId, templateId] of Object.entries(provenance)) {
    if (rowsAfterPurge.has(rowId)) continue;
    delete provenance[rowId];
    seededSet.delete(templateId);
    healedAny = true;
  }
  if (purgedRowIds.size > 0 || healedAny) {
    settings.set(trackerKey, Array.from(seededSet).join(','));
    settings.set(provenanceKey, JSON.stringify(provenance));
  }

  // Path (5): heal a stale `workflow_template` setting pointing at a
  // ULID that no longer exists.
  const storedTemplate = readFolderWorkflowTemplate(settings, folderId);
  const isUlidShape = /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(storedTemplate);
  if (isUlidShape && !rowsAfterPurge.has(storedTemplate)) {
    writeFolderWorkflowTemplate(settings, db, folderId, DEFAULT_TEMPLATE_ID);
  }
  if (activeSelectionDeleted) {
    writeFolderWorkflowTemplate(settings, db, folderId, DEFAULT_TEMPLATE_ID);
  }

  return {
    seededSet,
    provenance,
    purgedRowIds,
    activeSelectionDeleted,
    rowsAfterPurge,
  };
}

/**
 * Post-seed: align the per-folder workflow_template setting with the
 * seeded default row's ULID when the stored value still names a
 * legacy registry id and the seeded default is NOT a v2 draft.
 *
 * v2 GUARD: under Editor Model v2 the seeded default's definition is
 * a draft (mo_stage / reject_sink / complete_sink). The L2 linear
 * runner can't dispatch v2 drafts — pointing the setting at a v2
 * ULID would make every drag-to-todo return `workflow_not_runnable`
 * until the DAG runner ships. Old folders keep their legacy stored
 * value → resolveWorkflowDefinition falls back to LEGACY_LINEAR.
 */
export function alignWorkflowTemplateToSeed(
  deps: {
    settings: SettingsRepository;
    repo: WorkflowsRepository;
    folderId: string;
    folderTemplateSettingKey: (folderId: string) => string;
  },
  defaultRowId: string,
): void {
  const { settings, repo, folderId, folderTemplateSettingKey } = deps;
  const stored = readFolderWorkflowTemplate(settings, folderId);
  const isLegacyRegistryId =
    stored === DEFAULT_TEMPLATE_ID ||
    listWorkflowTemplates().some((t) => t.id === stored);
  if (!isLegacyRegistryId) return;
  const seededDefault = repo.getById(defaultRowId);
  const isDraft =
    seededDefault === null ||
    isDraftWorkflowDefinition(seededDefault.definition);
  if (!isDraft) {
    settings.set(folderTemplateSettingKey(folderId), defaultRowId);
  }
}
