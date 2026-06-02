-- L2.T1b partial — drop legacy tables / columns that have no live
-- consumers after the Mo Concierge full-removal (v1.4.6) and the
-- Folder/Kanban Settings Unification (v1.4.8, Morion ticket
-- 01KRJN74WV2BE40EJAX7PFN0RE).
--
-- What this migration drops:
--
--   1. `concierge_actions` table + indexes — the autonomous
--      workflow-supervisor action log. Last consumer (the
--      `runConciergeTick` engine + `ConciergeActionsRepository`) was
--      removed in `fb96fbe` (v1.4.6, 2026-05-05). Table has been
--      inert since.
--
--   2. Legacy columns on `concierge_folder_settings`:
--        - `grumpy_mentor` — autonomous-tick persona toggle
--        - `workflow` — house-style text for tick-side voice
--        - `schedule_mode` / `schedule_minutes` — per-folder tick
--          schedule (replaced by workspace-level Mo schedule in the
--          unified popup; mode column was already cosmetic after
--          v1.4.6 removed the tick)
--        - `last_tick_at` / `last_checkpoint_at` — recordTick output
--          (engine deleted, no writers)
--        - `checking_corners_enabled` / `brief_note_id` /
--          `brief_checkpoint_at` / `brief_last_digest_at` — orphaned
--          since Phase 6.1 Project Brief retirement (table dropped in
--          migration 0019; columns were left as NULL placeholders for
--          rollback safety).
--
--    Kept columns: folder_id (PK), enabled, linked_repo_path,
--    auto_code_enabled, topic_exclusions, created_at, updated_at.
--    (`intake_instruction` / `auto_merge_enabled` are workspace KV
--    rows under `auto_code.intake_instruction.<folderId>` /
--    `auto_code.auto_merge.<folderId>`, NOT columns here.)
--
-- What this migration does NOT drop:
--
--   - `mo_agent_queue` — still the primary durable queue for the
--     auto-code orchestrator (`src/core/auto-code/queue.ts` has 20+
--     active queries). Drop pairs with L2.T7 finish (orchestrator →
--     `workflow_runs` migration); separate ticket.
--
-- SQLite migrations are forward-only. Downgrading to a pre-v1.4.8
-- binary against this DB will SELECT * and see fewer columns than
-- expected — that path was already broken for `concierge_actions`
-- consumers since v1.4.6 anyway.

-- 1. concierge_actions.
DROP INDEX IF EXISTS idx_concierge_actions_folder;
DROP INDEX IF EXISTS idx_concierge_actions_session;
DROP TABLE IF EXISTS concierge_actions;

-- 2. concierge_folder_settings column drop via table-rebuild (SQLite
-- 3.35.0+ supports `ALTER TABLE ... DROP COLUMN`, but better-sqlite3
-- on Tauri's bundled SQLite plus the older Windows build path don't
-- always hit that version. Rebuild is portable and matches lessons.md
-- guidance for any non-trivial column change — Codex review on
-- migration 0022 mo_spend_ledger kind-CHECK widening).
PRAGMA foreign_keys = OFF;

CREATE TABLE _new_concierge_folder_settings (
  folder_id           TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
  enabled             INTEGER NOT NULL DEFAULT 0,
  -- Auto-code Phase 1 (migration 0020)
  linked_repo_path    TEXT,
  auto_code_enabled   INTEGER NOT NULL DEFAULT 0,
  -- Mo Indexing topic-exclusions (migration 0023)
  topic_exclusions    TEXT NOT NULL DEFAULT '',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

INSERT INTO _new_concierge_folder_settings (
  folder_id, enabled, linked_repo_path, auto_code_enabled,
  topic_exclusions, created_at, updated_at
)
SELECT
  folder_id,
  enabled,
  linked_repo_path,
  auto_code_enabled,
  COALESCE(topic_exclusions, ''),
  created_at,
  updated_at
FROM concierge_folder_settings;

DROP TABLE concierge_folder_settings;
ALTER TABLE _new_concierge_folder_settings RENAME TO concierge_folder_settings;

PRAGMA foreign_keys = ON;
