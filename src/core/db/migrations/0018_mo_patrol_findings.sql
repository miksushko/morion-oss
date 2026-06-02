-- Mo Indexing Redesign — Phase 5d patrol-log finding lifecycle.
--
-- Storage for individual Tier 0 deterministic findings so the user /
-- agent can mark each one accepted / dismissed / snoozed via
-- `mo_acknowledge_finding`. Without this table, lifecycle would have
-- to be encoded as in-band state lines inside `mo:patrol-log`'s
-- markdown body — fragile to parse and easy to corrupt with manual
-- edits. Side table is a cleaner separation: the patrol-log note is
-- the human-readable feed; this table is the machine-readable state.
--
-- The relationship to `mo:patrol-log` notes is one-way: appendFindings
-- inserts both a markdown line into the note body AND a row here.
-- Acknowledge updates only the table; the next patrol-log render can
-- skip non-open findings if desired (Phase 5d ships the table +
-- update tool only; the render-side filter is a follow-up).
--
-- folder_id is the canonical scope (FK CASCADE — when a folder is
-- deleted, all its findings die too). note_id is nullable because some
-- findings (e.g. "two duplicate ULIDs") legitimately don't tie to a
-- single note; CASCADE means a per-note finding evaporates when the
-- note is hard-deleted, which matches the user's mental model.

CREATE TABLE IF NOT EXISTS mo_patrol_findings (
  id                TEXT PRIMARY KEY,
  folder_id         TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  note_id           TEXT REFERENCES notes(id) ON DELETE CASCADE,
  finding_kind      TEXT NOT NULL,
  severity          TEXT NOT NULL,
  message           TEXT NOT NULL,
  context           TEXT NOT NULL DEFAULT '{}',  -- JSON object
  created_at        INTEGER NOT NULL,
  -- Lifecycle: open / accepted / dismissed / snoozed.
  -- 'open'      — fresh finding, agent should consider it.
  -- 'accepted'  — user / agent confirmed; do whatever the finding
  --               suggests (out-of-band action). Keeps the row for
  --               audit but skips it in future "what's pending?" views.
  -- 'dismissed' — user / agent rejects this finding kind for this row;
  --               re-detecting the same condition (kind + note + folder)
  --               should NOT re-surface it. Implementations can dedup
  --               by checking for prior dismissed rows.
  -- 'snoozed'   — temporarily hidden until `snooze_until`. After the
  --               wall clock passes, the row flips back to 'open' on
  --               read.
  state             TEXT NOT NULL DEFAULT 'open',
  state_changed_at  INTEGER NOT NULL,
  snooze_until      INTEGER  -- ms-epoch; only meaningful when state='snoozed'
);

CREATE INDEX IF NOT EXISTS idx_mo_patrol_findings_folder_state
  ON mo_patrol_findings(folder_id, state);

CREATE INDEX IF NOT EXISTS idx_mo_patrol_findings_dedup
  ON mo_patrol_findings(folder_id, note_id, finding_kind, state);
