-- Migration 0002: settings table.
-- Stores MCP gating + future user-tweakable knobs as JSON-encoded values.
-- Defaults are encoded by the absence of a row, NOT by inserting defaults at
-- migration time. The repository's getter takes a default and returns it when
-- the row is missing. This means a fresh DB has zero settings rows and every
-- toggle is "on" until the user flips it.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
