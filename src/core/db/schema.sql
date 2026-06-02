-- Morion canonical schema. Reference for "what's in the DB right now"
-- after every migration in `src/core/db/migrations/` has been applied.
-- This file is NOT executed at runtime — `client.ts` runs the numbered
-- migrations instead. Update this file whenever a migration lands so
-- grep-for-column-name keeps working.
--
-- Last refresh: 2026-04-19 (covers migrations 0001-0011).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- folders
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS folders (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  parent_id    TEXT REFERENCES folders(id) ON DELETE SET NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  -- Direction N (migration 0007): 'list' (default) or 'kanban'.
  -- Decides how the folder renders in the UI and which MCP tools apply.
  -- Data-preserving on flip.
  view_mode    TEXT NOT NULL DEFAULT 'list'
               CHECK (view_mode IN ('list', 'kanban')),
  -- Morion Pro (migration 0006): per-folder MCP gates. All default to 1
  -- so free-tier installs behave as pre-v0.98. Pro-tier evaluates these
  -- at every MCP tool call via canPerform(). Stored unconditionally —
  -- Pro→Free downgrade keeps the user's choices in DB, just inert.
  mcp_visible  INTEGER NOT NULL DEFAULT 1,
  mcp_create   INTEGER NOT NULL DEFAULT 1,
  mcp_update   INTEGER NOT NULL DEFAULT 1,
  mcp_delete   INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

-- ---------------------------------------------------------------------
-- notes
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,
  folder_id    TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  pinned       INTEGER NOT NULL DEFAULT 0,
  source       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  -- Direction N (0007): kanban column membership. 'note' is the default
  -- (reference material, not a task). In list-folders the column is
  -- present but hidden + not editable via UI. Status transitions do
  -- NOT bump updated_at — metadata, not content (lessons 2026-04-10).
  status       TEXT NOT NULL DEFAULT 'note'
               CHECK (status IN ('note','backlog','todo','doing','review','done')),
  -- Manual order inside a kanban column. REAL so drag-between-cards
  -- inserts a midpoint without renumbering. Nullable — unused in the
  -- 'note' column (chronological) and in list-folders.
  position     REAL,
  -- Morion Pro (0006): nullable per-note overrides. NULL means "inherit
  -- from folder" at check-time. No mcp_create because notes don't
  -- contain notes — creation is always gated against the destination
  -- folder.
  mcp_visible  INTEGER,
  mcp_update   INTEGER,
  mcp_delete   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notes_folder   ON notes(folder_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notes_pinned   ON notes(pinned)    WHERE deleted_at IS NULL AND pinned = 1;
CREATE INDEX IF NOT EXISTS idx_notes_updated  ON notes(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notes_kanban   ON notes(folder_id, status, position) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- tags + note_tags
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id     TEXT PRIMARY KEY,
  name   TEXT UNIQUE NOT NULL,
  color  TEXT
);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id);

-- ---------------------------------------------------------------------
-- attachments (MVP: metadata only, blob lives on disk)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  mime_type   TEXT,
  size_bytes  INTEGER,
  sha256      TEXT
);

CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_id);

-- ---------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id     TEXT,
  action      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  -- Direction N (0007): status_change rows carry the before/after
  -- kanban status so tasks_history(noteId) can reconstruct
  -- "who moved this card when". NULL for every other action.
  status_from TEXT,
  status_to   TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_note ON audit_log(note_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts   ON audit_log(ts);

-- ---------------------------------------------------------------------
-- settings (migration 0002). Typed key-value store. `key` is the slot
-- name ('mcp_enabled', 'mcp_category_read', 'license', ...), `value` is
-- either a JSON blob or a plain string depending on the key. Repository
-- owns the (de)serialisation — no joins, no FKs.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- ---------------------------------------------------------------------
-- note_revisions (migration 0004). Per-note version history. Repository
-- enforces 3-recent + 1-baseline (>=4h) retention at insert time so a
-- single note never exceeds four rows. Cascade on hard purge;
-- soft-delete leaves rows alone so Restore-from-Trash keeps history.
-- Body dedup normalises whitespace before compare (N20 2026-04-16).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS note_revisions (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  tags_json  TEXT NOT NULL,
  folder_id  TEXT,
  actor      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_revisions_note ON note_revisions(note_id, created_at DESC);

-- ---------------------------------------------------------------------
-- note_comments (migration 0009). Direction Q — free-form posts against
-- a note with 1-level reply threading. Unbounded growth (no retention);
-- comments are the discussion audit trail, unlike revisions which are a
-- capped safety net. 1-level enforcement lives in the repo, not SQL.
-- Cascade on note hard-purge + on parent-comment delete.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS note_comments (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL REFERENCES notes(id)          ON DELETE CASCADE,
  parent_id   TEXT          REFERENCES note_comments(id)  ON DELETE CASCADE,
  body        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_note_comments_note    ON note_comments(note_id, created_at);
CREATE INDEX IF NOT EXISTS idx_note_comments_parent  ON note_comments(parent_id) WHERE parent_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- FTS5 virtual table for keyword search. External content mode pointed
-- at `notes` so we don't duplicate body storage.
-- ---------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title,
  body,
  content='notes',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);

-- Sync triggers. Soft-deleted notes are excluded from FTS by deleting
-- their FTS row when `deleted_at` flips from NULL to non-NULL
-- (notes_au). Migration 0003 extended notes_au to re-insert on the
-- opposite transition (restore-from-trash regression).
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
  INSERT INTO notes_fts(rowid, title, body)
    SELECT new.rowid, new.title, new.body
    WHERE new.deleted_at IS NULL;
END;

-- ---------------------------------------------------------------------
-- Concierge / Mo per-folder state (migrations 0011, 0020 add-cols,
-- 0023 add-col, 0035 drop legacy)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS concierge_folder_settings (
  folder_id          TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
  enabled            INTEGER NOT NULL DEFAULT 0,
  -- Auto-code Phase 1 (migration 0020)
  linked_repo_path   TEXT,
  auto_code_enabled  INTEGER NOT NULL DEFAULT 0,
  -- Mo Indexing topic-exclusions (migration 0023)
  topic_exclusions   TEXT NOT NULL DEFAULT '',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS concierge_sessions (
  id              TEXT PRIMARY KEY,
  folder_id       TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title           TEXT NOT NULL DEFAULT '',
  opened_by       TEXT NOT NULL CHECK (opened_by IN ('user','concierge')),
  needs_human     INTEGER NOT NULL DEFAULT 0,
  archived_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_concierge_sessions_updated
  ON concierge_sessions(updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_concierge_sessions_needs_human
  ON concierge_sessions(needs_human) WHERE needs_human = 1;

CREATE TABLE IF NOT EXISTS concierge_messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES concierge_sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content      TEXT NOT NULL,
  tool_call_id TEXT,
  cost_usd     REAL NOT NULL DEFAULT 0,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  model        TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_concierge_messages_session
  ON concierge_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_concierge_messages_cost_day
  ON concierge_messages(created_at) WHERE cost_usd > 0;

-- ---------------------------------------------------------------------
-- Vector table is created at runtime by client.ts only if sqlite-vec is
-- loaded. Schema reference (do not run here, vec0 needs the extension).
-- Dimension MUST match core/embeddings/transformers.ts EMBEDDING_DIM.
-- Default model Xenova/multilingual-e5-small → 384.
-- ---------------------------------------------------------------------
-- CREATE VIRTUAL TABLE notes_vec USING vec0(
--   note_id TEXT PRIMARY KEY,
--   embedding float[384]
-- );
