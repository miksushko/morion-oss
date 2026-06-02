-- Migration 0001: initial schema (mirrors schema.sql).

CREATE TABLE folders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  parent_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_folders_parent ON folders(parent_id);

CREATE TABLE notes (
  id          TEXT PRIMARY KEY,
  folder_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

CREATE INDEX idx_notes_folder  ON notes(folder_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_pinned  ON notes(pinned)    WHERE deleted_at IS NULL AND pinned = 1;
CREATE INDEX idx_notes_updated ON notes(updated_at) WHERE deleted_at IS NULL;

CREATE TABLE tags (
  id     TEXT PRIMARY KEY,
  name   TEXT UNIQUE NOT NULL,
  color  TEXT
);

CREATE TABLE note_tags (
  note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

CREATE INDEX idx_note_tags_tag ON note_tags(tag_id);

CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  mime_type   TEXT,
  size_bytes  INTEGER,
  sha256      TEXT
);

CREATE INDEX idx_attachments_note ON attachments(note_id);

CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT,
  action  TEXT NOT NULL,
  actor   TEXT NOT NULL,
  ts      INTEGER NOT NULL
);

CREATE INDEX idx_audit_note ON audit_log(note_id);
CREATE INDEX idx_audit_ts   ON audit_log(ts);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  title,
  body,
  content='notes',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
  INSERT INTO notes_fts(rowid, title, body)
    SELECT new.rowid, new.title, new.body
    WHERE new.deleted_at IS NULL;
END;
