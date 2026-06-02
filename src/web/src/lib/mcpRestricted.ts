import type { Folder, FolderMcpPermissions, Note, NoteMcpPermissions } from './api';

/**
 * "Hidden from AI" is the catastrophic case — MCP can't even read the
 * resource. That's the only state worth an inline indicator in the
 * default chrome-free view. Partial restrictions (AI can read but can't
 * create/edit/delete) are recoverable and surface in the opt-in
 * "Review MCP access" mode instead.
 */
export function isFolderHiddenFromAI(folder: Folder): boolean {
  return !folder.mcpPermissions.visible;
}

export function isNoteHiddenFromAI(note: Note, folder: Folder | null): boolean {
  return !effectiveNotePerms(note, folder).visible;
}

/**
 * Effective permissions for a note — note override wins when non-null,
 * otherwise the containing folder's value, otherwise true for unfiled
 * (nothing to inherit from, default allow).
 */
export interface EffectiveNotePerms {
  visible: boolean;
  update: boolean;
  delete: boolean;
}

export function effectiveNotePerms(note: Note, folder: Folder | null): EffectiveNotePerms {
  const n = note.mcpPermissions;
  return {
    visible: resolve(n.visible, folder?.mcpPermissions.visible ?? true),
    update: resolve(n.update, folder?.mcpPermissions.update ?? true),
    delete: resolve(n.delete, folder?.mcpPermissions.delete ?? true),
  };
}

/**
 * Did the user set ANY custom rule on this note (override its inheritance)?
 * Used by review mode to distinguish inherited rows from pinned rows.
 */
export function noteHasCustomRules(note: Note): boolean {
  const n = note.mcpPermissions;
  return n.visible !== null || n.update !== null || n.delete !== null;
}

function resolve(override: boolean | null, folderValue: boolean): boolean {
  return override === null ? folderValue : override;
}

// Re-export the original types here so call sites can import everything
// from one place if they want. Keeps this file the single public
// surface for anything MCP-perms related in the web app.
export type { FolderMcpPermissions, NoteMcpPermissions };
