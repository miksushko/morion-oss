import type Database from 'better-sqlite3';
import type { AuditLogger } from '../../audit/log.js';
import type { Note } from '../types.js';
import { getById } from './read.js';

/**
 * Per-note MCP permission overrides. NULL columns mean "inherit from
 * folder" — pass null to remove an override and fall back to the
 * folder's value. Returns the updated note (with merged-from-row perms,
 * not yet inheritance-resolved — that's `canPerform`'s job).
 */
export function setMcpPermissions(
  db: Database.Database,
  audit: AuditLogger,
  id: string,
  perms: { visible: boolean | null; update: boolean | null; delete: boolean | null },
): Note | null {
  const result = db
    .prepare(
      'UPDATE notes SET mcp_visible = ?, mcp_update = ?, mcp_delete = ? WHERE id = ?',
    )
    .run(
      perms.visible === null ? null : (perms.visible ? 1 : 0),
      perms.update === null ? null : (perms.update ? 1 : 0),
      perms.delete === null ? null : (perms.delete ? 1 : 0),
      id,
    );
  if (result.changes === 0) return null;
  return getById(db, audit, id, { includeTrashed: true });
}
