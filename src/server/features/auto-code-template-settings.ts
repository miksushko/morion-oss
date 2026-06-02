import type Database from 'better-sqlite3';

import type { ToolContext } from '../tools/types.js';
import {
  DEFAULT_TEMPLATE_ID,
  getWorkflowTemplate,
} from '../../core/auto-code/workflows/templates.js';
import { WorkflowsRepository } from '../../core/auto-code/workflows/workflows-repository.js';

/**
 * Per-folder workflow selection — read/write helpers backed by
 * workspace settings KV. One key per folder so the existing
 * `concierge_folder_settings` schema stays untouched (no migration).
 *
 * Setting key shape: `auto_code.workflow_template.<folderId>`
 * Value: EITHER a built-in template id from `templates.ts`
 * registry (e.g. `'default'`, `'pi-fix'`, `'claude-solo'`) OR a
 * `workflows.id` ULID for a user-defined workflow row (Этап 2).
 * Missing or stale values fall back to `DEFAULT_TEMPLATE_ID`.
 *
 * The resolution order on read is:
 *
 *   1. Built-in registry (`getWorkflowTemplate(id)`).
 *   2. `workflows` table lookup (`workflowsRepo.getById(id)`).
 *   3. Fallback to `DEFAULT_TEMPLATE_ID`.
 *
 * The split lets users pick a built-in OR a custom workflow with
 * the same dropdown — the UI lists both in one merged collection.
 *
 * Used by:
 *   - WorkflowOrchestrator factory's `resolveDefinition` injection
 *   - HTTP route GET/PUT folder-settings (surfaces `workflowTemplate`
 *     field)
 */

export const FOLDER_TEMPLATE_SETTING_PREFIX = 'auto_code.workflow_template.';

export function folderTemplateSettingKey(folderId: string): string {
  return `${FOLDER_TEMPLATE_SETTING_PREFIX}${folderId}`;
}

/** Raw stored value (registry id OR workflows.id ULID), or
 *  `DEFAULT_TEMPLATE_ID` when missing / structurally invalid (empty
 *  string, non-string). Does NOT validate against the registry or
 *  the DB — callers downstream do the lookup so a stale id only
 *  affects resolution, not the UI's read of "what did the user
 *  pick last?". */
export function readFolderWorkflowTemplate(
  settings: ToolContext['settings'],
  folderId: string,
): string {
  const raw = settings.get<unknown>(folderTemplateSettingKey(folderId), null);
  if (typeof raw !== 'string' || raw.length === 0) return DEFAULT_TEMPLATE_ID;
  return raw;
}

/** Write the per-folder workflow id. The value must resolve EITHER
 *  to a registry template OR to a `workflows` row OWNED BY THIS
 *  FOLDER, else the helper throws. Pass `DEFAULT_TEMPLATE_ID` to
 *  clear back to default; we still write the row so the user's
 *  explicit choice is auditable on subsequent reads. */
export function writeFolderWorkflowTemplate(
  settings: ToolContext['settings'],
  db: Database.Database,
  folderId: string,
  selection: string,
): void {
  if (!validateFolderWorkflowSelection(db, folderId, selection)) {
    throw new Error(`unknown workflow selection: "${selection}"`);
  }
  settings.set(folderTemplateSettingKey(folderId), selection);
}

/** True when `selection` resolves to either a built-in template id
 *  OR a `workflows` row that exists AND is owned by `folderId`.
 *
 *  Folder-scoping (Codex P1b round 3, 2026-05-10): without the
 *  ownership check, a user could point folder A at a workflow row
 *  owned by folder B and silently run B's definition under A's
 *  context. Cross-folder routing is not a feature; surface as
 *  invalid instead. */
export function validateFolderWorkflowSelection(
  db: Database.Database,
  folderId: string,
  selection: string,
): boolean {
  if (getWorkflowTemplate(selection)) return true;
  const repo = new WorkflowsRepository(db);
  return repo.getByIdForFolder(selection, folderId) !== null;
}

/**
 * Keep `workflows.is_default` consistent with `settings.workflowTemplate`
 * for a folder. The two used to be independent — one row could carry the
 * "default" badge in the workflows list while the dropdown in folder
 * settings pointed at a different row (user feedback 2026-05-18 on
 * ticket 01KRWQPDKQ2RZMDBJZ5KN0B7YE follow-up). Now they sync:
 *
 *   - selection is a custom row ULID owned by this folder
 *       → set is_default=1 on that row, clear from siblings (the
 *         repo's `update({ isDefault: true })` already does the
 *         singleton clear in one transaction).
 *   - selection is a built-in template id (no row matches)
 *       → clear is_default from every row in the folder. Built-in
 *         templates don't have a row, so leaving a stale badge on a
 *         custom row would lie about what's actually running.
 *   - selection doesn't resolve (defensive — caller should have
 *         validated via `validateFolderWorkflowSelection`)
 *       → no-op.
 */
export function syncRowDefaultWithFolderSelection(
  db: Database.Database,
  folderId: string,
  selection: string,
): void {
  const repo = new WorkflowsRepository(db);
  const row = repo.getByIdForFolder(selection, folderId);
  if (row) {
    if (!row.isDefault) {
      repo.update(row.id, { isDefault: true });
    }
    return;
  }
  if (getWorkflowTemplate(selection)) {
    // Built-in template pick — clear default badge from every row in
    // the folder so the workflows list doesn't lie.
    db.prepare(
      `UPDATE workflows SET is_default = 0, updated_at = ?
       WHERE folder_id = ? AND is_default = 1`,
    ).run(Date.now(), folderId);
  }
}

// ---------------------------------------------------------------------
// Per-folder intake instruction (Editor Model v2 spec — Morion note
// 01KRAQWPXR5AYTFVF6J12TYHJ1). The user can override the workflow's
// hard-coded `mo_start.instruction` with a folder-level free-text rule
// without diving into the workflow editor. Surfaced in the folder's
// Auto-Code settings panel beside the workflow template picker.
//
// Stored in workspace settings KV under
// `auto_code.intake_instruction.<folderId>`. Empty / missing →
// resolver leaves the workflow's default mo_start instruction
// untouched.
// ---------------------------------------------------------------------

export const FOLDER_INTAKE_INSTRUCTION_SETTING_PREFIX =
  'auto_code.intake_instruction.';

export function folderIntakeInstructionKey(folderId: string): string {
  return `${FOLDER_INTAKE_INSTRUCTION_SETTING_PREFIX}${folderId}`;
}

/** Read the folder's intake-instruction override. Empty string when
 *  unset OR when the stored value isn't a non-empty string — callers
 *  treat empty as "use the workflow's own default". */
export function readFolderIntakeInstruction(
  settings: ToolContext['settings'],
  folderId: string,
): string {
  const raw = settings.get<unknown>(folderIntakeInstructionKey(folderId), null);
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

/** Write the folder's intake-instruction override. Pass an empty
 *  string to clear back to the workflow's default. Capped at 4000
 *  chars to keep the Mo prompt token-budget predictable. */
export const FOLDER_INTAKE_INSTRUCTION_MAX_LEN = 4000;

export function writeFolderIntakeInstruction(
  settings: ToolContext['settings'],
  folderId: string,
  value: string,
): void {
  const trimmed = value.trim();
  if (trimmed.length > FOLDER_INTAKE_INSTRUCTION_MAX_LEN) {
    throw new Error(
      `intake instruction too long: ${trimmed.length} chars (max ${FOLDER_INTAKE_INSTRUCTION_MAX_LEN})`,
    );
  }
  settings.set(folderIntakeInstructionKey(folderId), trimmed);
}

// ---------------------------------------------------------------------
// Per-folder auto-merge toggle. When enabled, the orchestrator's
// `onRunTerminal` done branch invokes `mergeWorktreeIntoTarget` right
// after marking the run done, so the user doesn't have to click
// "Merge into main" by hand. Default OFF for back-compat with the
// existing manual-merge UX — flipping the toggle is an explicit
// "I trust auto-code, just apply changes" opt-in.
//
// Stored under `auto_code.auto_merge.<folderId>` as a bare string
// boolean (`'1'` / `'0'`). Missing / structurally invalid → false.
// ---------------------------------------------------------------------

export const FOLDER_AUTO_MERGE_SETTING_PREFIX = 'auto_code.auto_merge.';

export function folderAutoMergeKey(folderId: string): string {
  return `${FOLDER_AUTO_MERGE_SETTING_PREFIX}${folderId}`;
}

/** Read the folder's auto-merge toggle. Returns false (manual merge
 *  via drawer button) when unset or stored value is not the truthy
 *  `'1'` sentinel. */
export function readFolderAutoMerge(
  settings: ToolContext['settings'],
  folderId: string,
): boolean {
  const raw = settings.get<unknown>(folderAutoMergeKey(folderId), null);
  return raw === '1' || raw === true;
}

/** Write the folder's auto-merge toggle. Persists as `'1'` / `'0'`
 *  so the settings KV row is human-inspectable; the read helper
 *  accepts both string and boolean for forward-compat. */
export function writeFolderAutoMerge(
  settings: ToolContext['settings'],
  folderId: string,
  value: boolean,
): void {
  settings.set(folderAutoMergeKey(folderId), value ? '1' : '0');
}
