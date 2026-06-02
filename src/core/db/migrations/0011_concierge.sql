-- Direction V — Morion Concierge (internal workflow supervisor).
-- Spec: Morion note "Morion Concierge: internal workflow supervisor"
-- (01KPZJ5DW95X1DSCHQFB8794XP). Pro-gated feature — stored rows stay
-- inert on Free tier (same data-preserve rule as MCP permissions +
-- kanban quota, lesson 2026-04-14 "Premium gates: data-preserve on
-- downgrade").

-- ---------------- Per-folder supervisor config -----------------------
-- One row per folder the user has opted into Concierge supervision
-- for. Absence of a row = disabled (default). `workflow` is the
-- plain-English policy the user writes into the settings textarea —
-- it feeds the LLM's system prompt alongside the allowlist/guardrails
-- layer, NOT as absolute authority (see spec § Security).
CREATE TABLE IF NOT EXISTS concierge_folder_settings (
  folder_id          TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
  enabled            INTEGER NOT NULL DEFAULT 0,
  grumpy_mentor      INTEGER NOT NULL DEFAULT 1,
  workflow           TEXT NOT NULL DEFAULT '',
  schedule_mode      TEXT NOT NULL DEFAULT 'manual' CHECK (schedule_mode IN ('manual','timer')),
  schedule_minutes   INTEGER NOT NULL DEFAULT 5 CHECK (schedule_minutes IN (1,5,15)),
  last_tick_at       INTEGER,
  last_checkpoint_at INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- ---------------- Chat sessions (user <-> Concierge) -----------------
-- ChatGPT/Claude-shaped sidebar. `opened_by='user'` = user asked a
-- question; `opened_by='concierge'` = the supervisor needed human input
-- and spawned a chat itself. `needs_human=1` drives the Sidebar tab
-- badge count + the per-row indicator chip.
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

-- ---------------- Chat messages --------------------------------------
-- Role follows the OpenAI/Anthropic convention so provider mapping is
-- trivial. `cost_usd` per-message lets the $5/day budget cap be
-- enforced by `SUM(cost_usd)` over today's rows — no separate ledger
-- table, no double-entry bookkeeping.
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

-- ---------------- Action log -----------------------------------------
-- Every action the Concierge attempts/executes. Separate table from
-- audit_log because (a) it carries the LLM's REASONING ("why did you
-- do this") which audit_log doesn't, (b) per-folder queryability is a
-- first-class concern, (c) `dry_run=1` rows are recorded but never
-- actually hit the underlying repo — preview mode for a first tick on
-- a newly-enabled folder. `kind` mirrors the allowlist of underlying
-- operations (tasks_move, notes_add_comment, session_open, …); adding
-- a new action type means editing the engine dispatcher AND one DB
-- comment, not a schema migration.
CREATE TABLE IF NOT EXISTS concierge_actions (
  id          TEXT PRIMARY KEY,
  folder_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
  session_id  TEXT REFERENCES concierge_sessions(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  target_id   TEXT,
  payload     TEXT NOT NULL DEFAULT '{}',
  reasoning   TEXT NOT NULL DEFAULT '',
  dry_run     INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_concierge_actions_folder
  ON concierge_actions(folder_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_concierge_actions_session
  ON concierge_actions(session_id, created_at);
