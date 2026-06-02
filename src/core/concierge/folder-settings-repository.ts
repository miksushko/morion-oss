import type Database from 'better-sqlite3';
import type { ConciergeFolderSettings } from './types.js';

interface Row {
  folder_id: string;
  enabled: number;
  // Auto-code Phase 1 (migration 0020). NULL on legacy rows.
  linked_repo_path: string | null;
  auto_code_enabled: number;
  // Mo Indexing topic-exclusions (migration 0023). Empty string on legacy rows.
  topic_exclusions: string;
  created_at: number;
  updated_at: number;
}

function rowToSettings(row: Row): ConciergeFolderSettings {
  return {
    folderId: row.folder_id,
    enabled: row.enabled === 1,
    linkedRepoPath: row.linked_repo_path,
    autoCodeEnabled: row.auto_code_enabled === 1,
    topicExclusions: row.topic_exclusions ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function defaultSettings(folderId: string, now: number): ConciergeFolderSettings {
  return {
    folderId,
    enabled: false,
    linkedRepoPath: null,
    autoCodeEnabled: false,
    topicExclusions: '',
    createdAt: now,
    updatedAt: now,
  };
}

export interface FolderSettingsPatch {
  enabled?: boolean;
  /** Auto-code Phase 1 — pass `null` to clear the link; pass an
   * absolute path string to set. The route validates it points at a
   * real git repo before persisting (repo layer trusts the value). */
  linkedRepoPath?: string | null;
  /** Auto-code Phase 1. The route refuses `true` when
   * `linkedRepoPath` is null on the resulting state (rejected with
   * `linked_repo_required`). */
  autoCodeEnabled?: boolean;
  /** Mo Indexing — free-text generic-terms blocklist for Tier 1.
   * Empty string clears it (no per-folder rules; only the workspace
   * category rules apply). Trimmed by the caller (route layer). */
  topicExclusions?: string;
}

/**
 * Per-folder Mo + auto-code state. Absence of a row = disabled with
 * default field values. Callers always get back a full settings
 * object via `getOrDefault`, so UI code doesn't have to null-check
 * every field. The row is created on first `update()`.
 *
 * Schema history: migration 0011 created the table with Mo Concierge
 * fields; 0020 added auto-code Phase 1 columns; 0023 added the
 * topic-exclusions column; 0035 (v1.4.8) dropped the autonomous-tick
 * legacy columns (`grumpy_mentor`, `workflow`, `schedule_*`,
 * `last_tick_at`, `last_checkpoint_at`, `checking_corners_enabled`,
 * `brief_*`) after the Mo Concierge full-removal in v1.4.6.
 *
 * `intakeInstruction` + `autoMergeEnabled` live in workspace settings
 * (`auto_code.intake_instruction.<folderId>` /
 * `auto_code.auto_merge.<folderId>`), not as columns here.
 */
export class ConciergeFolderSettingsRepository {
  constructor(private readonly db: Database.Database) {}

  getOrDefault(folderId: string): ConciergeFolderSettings {
    const row = this.db
      .prepare<[string], Row>(
        'SELECT * FROM concierge_folder_settings WHERE folder_id = ?',
      )
      .get(folderId);
    if (!row) return defaultSettings(folderId, Date.now());
    return rowToSettings(row);
  }

  /**
   * Upsert the config for a folder. First write creates the row;
   * subsequent writes merge fields. Returns the full settings.
   */
  update(
    folderId: string,
    patch: FolderSettingsPatch,
    now: number = Date.now(),
  ): ConciergeFolderSettings {
    const existing = this.getOrDefault(folderId);
    const next: ConciergeFolderSettings = {
      ...existing,
      ...patch,
      folderId,
      updatedAt: now,
    };
    const exists = this.db
      .prepare<[string], { n: number }>(
        'SELECT 1 AS n FROM concierge_folder_settings WHERE folder_id = ?',
      )
      .get(folderId);
    if (exists) {
      this.db
        .prepare(
          `UPDATE concierge_folder_settings SET
             enabled = ?, linked_repo_path = ?, auto_code_enabled = ?,
             topic_exclusions = ?, updated_at = ?
           WHERE folder_id = ?`,
        )
        .run(
          next.enabled ? 1 : 0,
          next.linkedRepoPath,
          next.autoCodeEnabled ? 1 : 0,
          next.topicExclusions,
          next.updatedAt,
          folderId,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO concierge_folder_settings (
             folder_id, enabled, linked_repo_path, auto_code_enabled,
             topic_exclusions, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          next.folderId,
          next.enabled ? 1 : 0,
          next.linkedRepoPath,
          next.autoCodeEnabled ? 1 : 0,
          next.topicExclusions,
          next.createdAt,
          next.updatedAt,
        );
    }
    return next;
  }

  /** Every folder the user has opted in with `enabled=true`. Used by
   * the scheduler to pick candidates for the next Mo-indexing tick. */
  listEnabled(): ConciergeFolderSettings[] {
    const rows = this.db
      .prepare<[], Row>('SELECT * FROM concierge_folder_settings WHERE enabled = 1')
      .all();
    return rows.map(rowToSettings);
  }
}
