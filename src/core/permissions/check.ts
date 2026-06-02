import type { Folder, Note, FolderMcpPermissions } from '../notes/types.js';
import type { ToolContext } from '../../server/tools/types.js';
import { isFolderMcpHidden, isNoteMcpHidden } from '../archive/check.js';

/**
 * Resource-level MCP permission check.
 *
 * Single source of truth for "is this MCP client allowed to perform
 * this action on this folder / note?". Called by:
 *   - Single-resource tools (`notes_get`, `notes_update`, `folders_rename`, …)
 *     before doing the actual work — return a denied envelope on false.
 *   - Collection tools (`notes_list`, `notes_search`, `folders_list`)
 *     post-filter their result rows through `canPerform('read', ...)`.
 *
 * Enforcement is always on (open-source build — no license tier). The
 * default permission rows are all-true, so an install that never set a
 * restriction behaves exactly as if ungated; only folders / notes the
 * user explicitly restricts gate the MCP caller.
 *
 * Inheritance: notes carry NULLABLE override columns (`mcp_visible` /
 * `mcp_update` / `mcp_delete`). null = "inherit from folder". A note
 * with `mcp_visible = false` is hidden even when the folder permits it.
 * A note with `mcp_visible = null` defers to the folder.
 */

export type Action = 'read' | 'create' | 'update' | 'delete';

export type Target =
  | { kind: 'folder'; folderId: string }
  | { kind: 'note'; noteId: string }
  /** New note that hasn't been created yet — gate `notes_create` against
   * the destination folder (or the unfiled defaults if folderId is null). */
  | { kind: 'newNote'; folderId: string | null };

/** Default permissions for unfiled notes (folder_id IS NULL). Stored in
 * the settings KV; when missing, all-true. */
export interface UnfiledDefaults extends FolderMcpPermissions {}

const UNFILED_DEFAULTS: UnfiledDefaults = {
  visible: true,
  create: true,
  update: true,
  delete: true,
};

export function getUnfiledDefaults(ctx: ToolContext): UnfiledDefaults {
  return ctx.settings.get<UnfiledDefaults>('unfiledMcpPermissions', UNFILED_DEFAULTS);
}

/**
 * The decision function. Returns true to allow, false to deny.
 *
 * Lookups inside (folder + note rows) are read-only and cheap; we don't
 * cache because settings/perms can change between calls within the same
 * MCP session and a stale cache would leak data we just told the user
 * is hidden.
 */
export function canPerform(action: Action, ctx: ToolContext, target: Target): boolean {
  // Archive gate runs FIRST for MCP callers regardless of tier —
  // archive visibility is a user-facing privacy feature, not a paid
  // one. User-actor (UI) bypasses so users can interact with their
  // archived items (toggle "Show Archived" then rename / unarchive /
  // delete). Ticket 01KPGNY92RPYA4AEPC32C9HH0P #5.
  const isMcpCaller = ctx.actor.startsWith('mcp:');
  if (isMcpCaller) {
    if (target.kind === 'note') {
      const n = ctx.notes.getById(target.noteId, { includeTrashed: true });
      if (n && isNoteMcpHidden(n, ctx)) return false;
    } else if (target.kind === 'folder') {
      const f = ctx.folders.getById(target.folderId);
      if (f && isFolderMcpHidden(f)) return false;
    } else if (target.kind === 'newNote' && target.folderId !== null) {
      const f = ctx.folders.getById(target.folderId);
      if (f && isFolderMcpHidden(f)) return false;
    }
  }

  // CRITICAL — the entire permission system gates MCP callers only.
  // User UI must NEVER be blocked by MCP permissions. Toggling "Visible
  // to AI" off on a folder is a signal to AI clients, not a soft-delete
  // for the user. Without this guard a Pro user who flips visible=false
  // loses access to their own notes (2026-04-25 bug report: "все таски
  // и заметки пропадают и для пользователя, будто soft deleted").
  // Archive gate above handled its own user/mcp discrimination; this
  // block must too. Sprint 0 N1 fixed MCP write gating but assumed the
  // existing read gating was correct — it wasn't for user-actor.
  if (!isMcpCaller) return true;

  if (target.kind === 'folder') {
    const folder = ctx.folders.getById(target.folderId);
    if (!folder) return false;
    return effectiveFolderAllows(folder.mcpPermissions, action);
  }

  if (target.kind === 'newNote') {
    if (action !== 'create') return false; // create is the only meaningful action for a not-yet-existing note
    if (target.folderId === null) {
      return getUnfiledDefaults(ctx).create;
    }
    const folder = ctx.folders.getById(target.folderId);
    if (!folder) return false;
    return folder.mcpPermissions.create;
  }

  // target.kind === 'note' — `create` doesn't apply (you can't create
  // an existing note); the only valid actions on a note are read/update/delete.
  if (action === 'create') return false;

  const note = ctx.notes.getById(target.noteId, { includeTrashed: true });
  if (!note) return false;

  // Resolve folder permissions: inherited from folder OR unfiled defaults.
  const folderPerms: FolderMcpPermissions = note.folderId
    ? (ctx.folders.getById(note.folderId)?.mcpPermissions ?? allTrue())
    : getUnfiledDefaults(ctx);

  return effectiveNoteAllows(folderPerms, note.mcpPermissions, action);
}

/** Evaluate a folder's permissions for a given action. */
function effectiveFolderAllows(perms: FolderMcpPermissions, action: Action): boolean {
  switch (action) {
    case 'read': return perms.visible;
    case 'create': return perms.visible && perms.create;
    case 'update': return perms.visible && perms.update;
    case 'delete': return perms.visible && perms.delete;
  }
}

/** Evaluate a note's permissions, falling back to the folder for nulls.
 * Notes can't be the 'create' target directly — `newNote` handles that. */
function effectiveNoteAllows(
  folderPerms: FolderMcpPermissions,
  noteOverrides: Note['mcpPermissions'],
  action: Exclude<Action, 'create'>,
): boolean {
  // Folder-level visibility always wins for hiding: an invisible folder
  // means all its notes are invisible regardless of per-note overrides.
  if (!folderPerms.visible) return false;

  switch (action) {
    case 'read': {
      const own = noteOverrides.visible;
      return own === null ? true : own;
    }
    case 'update': {
      if (!folderPerms.update) return false;
      const own = noteOverrides.update;
      return own === null ? true : own;
    }
    case 'delete': {
      if (!folderPerms.delete) return false;
      const own = noteOverrides.delete;
      return own === null ? true : own;
    }
  }
  // Should be unreachable given the union exhaustion above.
  // TypeScript can't narrow `action` to never inside switch without exhaustiveness check.
  // (no return needed — all cases above return)
}

function allTrue(): FolderMcpPermissions {
  return { visible: true, create: true, update: true, delete: true };
}

/** Filter helper for collection tools — returns only the items the
 * caller can read. Used by notes_list / folders_list / notes_search.
 *
 * Short-circuits for ALL non-MCP callers regardless of tier — user UI
 * sees every item it owns, full stop. MCP permissions gate AI clients
 * only. (Pre-2026-04-25: only Free + non-MCP short-circuited; Pro
 * user-actor fell through to the filter and lost access to its own
 * "Visible to AI = false" folders. Soft-delete-shaped bug.) */
export function filterReadable<T extends Folder | Note>(items: T[], ctx: ToolContext): T[] {
  const isMcpCaller = ctx.actor.startsWith('mcp:');
  if (!isMcpCaller) return items;
  return items.filter((item) => {
    const target: Target = 'name' in item
      ? { kind: 'folder', folderId: item.id }
      : { kind: 'note', noteId: item.id };
    return canPerform('read', ctx, target);
  });
}

/** Standardised denial envelope — used by single-resource tools so the
 * MCP client gets a consistent, machine-parseable signal rather than a
 * thrown error or a silent null. Mirrors the shape of the existing
 * `mcp_disabled` / `mcp_category_disabled` envelopes from the gate. */
export const ACCESS_DENIED = {
  error: 'mcp_access_denied',
  message: 'This folder or note is restricted from MCP access. Adjust permissions in Morion settings.',
} as const;
