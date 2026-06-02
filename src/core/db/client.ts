import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the directory holding `*.sql` migration files.
 *
 * Resolution order:
 *   1. `MORION_MIGRATIONS_DIR` env var (absolute or cwd-relative). Tauri /
 *      `bun build --compile` ships migrations under `Resources/` and points
 *      this at the bundled location.
 *   2. `<this file>/migrations` — works for both the source layout
 *      (`src/core/db/migrations/`) and the compiled layout
 *      (`dist/core/db/migrations/`) because tsc copies the .sql files...
 *      actually it doesn't, so for compiled mode we fall back to the
 *      source dir at the repo root.
 *   3. `<this file>/../../../src/core/db/migrations` — compiled fallback
 *      that walks back up from `dist/core/db/client.js` to the source
 *      `src/core/db/migrations/` directory.
 */
function resolveMigrationsDir(): string {
  const envOverride = process.env.MORION_MIGRATIONS_DIR;
  if (envOverride && envOverride.length > 0) {
    return isAbsolute(envOverride) ? envOverride : resolve(process.cwd(), envOverride);
  }
  const adjacent = resolve(__dirname, 'migrations');
  if (existsSync(adjacent)) return adjacent;
  return resolve(__dirname, '..', '..', '..', 'src', 'core', 'db', 'migrations');
}
// Matches the default embedding provider (@huggingface/transformers +
// Xenova/multilingual-e5-small → 384-dim). If you swap the model, change this
// in lockstep; the notes_vec virtual table is created with this literal size.
const EMBEDDING_DIM = 384;

export interface DbHandle {
  db: Database.Database;
  hasVec: boolean;
}

export interface OpenDbOptions {
  /** Absolute path to the SQLite file. Use ':memory:' for tests. */
  path: string;
  /** If true, suppress sqlite-vec loading errors and continue without vector search. Default: true. */
  optionalVec?: boolean;
}

/**
 * Open the Morion database, run any pending migrations, and (best-effort) load
 * the sqlite-vec extension. Returns a handle that callers should hold for the
 * lifetime of the process.
 */
export function openDb(opts: OpenDbOptions): DbHandle {
  const { path, optionalVec = true } = opts;

  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const hasVec = loadSqliteVec(db, optionalVec);
  runMigrations(db);
  if (hasVec) {
    ensureVecTable(db);
    ensureMoMetadataVecTable(db);
  }

  return { db, hasVec };
}

function loadSqliteVec(db: Database.Database, optional: boolean): boolean {
  try {
    // If MORION_SQLITE_VEC_PATH is set (e.g. by Tauri pointing to the bundled
    // dylib), load the extension directly instead of relying on the sqlite-vec
    // npm package's node_modules resolution. Safety net for signed .app bundles
    // where module resolution might not find the dylib.
    const envPath = process.env.MORION_SQLITE_VEC_PATH;
    if (envPath && envPath.length > 0) {
      db.loadExtension(envPath);
    } else {
      sqliteVec.load(db);
    }
    return true;
  } catch (err) {
    if (!optional) throw err;
    // Silently degrade. Search will fall back to FTS5-only.
    return false;
  }
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const migrationsDir = resolveMigrationsDir();
  if (!existsSync(migrationsDir)) return;

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: string }).version),
  );

  const insertVersion = db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)');

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      insertVersion.run(version, Date.now());
    });
    tx();
  }
}

function ensureVecTable(db: Database.Database): void {
  // vec0 virtual table can only be created when sqlite-vec is loaded.
  // It's not part of regular migrations because the extension may be missing.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_vec USING vec0(
      note_id TEXT PRIMARY KEY,
      embedding float[${EMBEDDING_DIM}]
    );
  `);
}

/**
 * Per-note Mo metadata vector table. Distinct from `notes_vec` (which
 * embeds the full note body for hybrid search) — this table embeds
 * `summary + ' ' + keywords.join(' ')` from `note_mo_metadata`, the
 * Tier-1-generated semantic gist of the note. Mo's deep-context-gather
 * pipeline (`mo_get_context`) ranks candidate notes by cosine over THIS
 * embedding so cheap-metadata-first filtering picks "what's actually
 * about X" instead of just "what mentions X verbatim".
 *
 * Same dim as `notes_vec` because we share the embedder. Same
 * `if (hasVec) create` pattern — when sqlite-vec is missing the system
 * gracefully degrades to FTS5-only over the summary text.
 */
function ensureMoMetadataVecTable(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS mo_metadata_vec USING vec0(
      note_id TEXT PRIMARY KEY,
      embedding float[${EMBEDDING_DIM}]
    );
  `);
}

export const VEC_DIM = EMBEDDING_DIM;
