import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Attachment files live in `<configDir>/attachments/<ulid>.<ext>`. No
 * sharding in v1 — filesystems handle ~10k files per dir easily, and we
 * can add `<aa>/<bb>/<fullid>.<ext>` sharding later as a schema-less
 * migration because the DB stores the full absolute path.
 *
 * Lifecycle:
 *   - `ensureAttachmentsDir(configDir)` — called once per upload to create
 *     the dir if it doesn't exist.
 *   - Files are written atomically: stream to `<id>.partial`, rename to
 *     `<id>.<ext>` only after sha256 verify.
 *   - Orphan cleanup: files are unlinked only when the owning note is
 *     hard-purged (7-day trash expiry or empty-trash). If a user deletes
 *     an image in-body but keeps the note, the file stays until purge.
 *     Pattern mirrors Slack / Linear / GitHub. Avoids the Ctrl-Z
 *     data-loss risk of diff-on-update cleanup.
 */

export function attachmentsDir(configDir: string): string {
  return join(configDir, 'attachments');
}

export function attachmentPath(configDir: string, id: string, ext: string): string {
  return join(attachmentsDir(configDir), `${id}.${ext}`);
}

export function attachmentPartialPath(configDir: string, id: string, ext: string): string {
  return join(attachmentsDir(configDir), `${id}.${ext}.partial`);
}

/**
 * Idempotent — subsequent calls are cheap (mkdir `recursive: true` no-ops
 * when the dir already exists). Callers don't need to check existsSync
 * before invoking.
 */
export function ensureAttachmentsDir(configDir: string): string {
  const dir = attachmentsDir(configDir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Derive the config dir from a known-good `dbPath`. `buildRuntime` passes
 * `config.dbPath` straight to repositories; this helper lets the
 * attachments repo + upload route share the same anchor without a second
 * env lookup. Using `dirname(dbPath)` keeps the sibling layout
 * (`<dir>/morion.db` + `<dir>/attachments/`) explicit.
 */
export function configDirFromDbPath(dbPath: string): string {
  return dirname(dbPath);
}
