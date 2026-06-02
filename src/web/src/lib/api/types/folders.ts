/**
 * Folders domain types — Folder, view-mode enum, folder MCP
 * permissions, kanban board response shape.
 */

import type { Note, NoteStatus } from './notes';

export const FOLDER_VIEW_MODES = ['list', 'kanban'] as const;

export type FolderViewMode = (typeof FOLDER_VIEW_MODES)[number];

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
  createdAt: number;
  /** Direction N — 'list' (classic notes) or 'kanban' (work board). */
  viewMode: FolderViewMode;
  archivedAt: number | null;
  noteCount: number;
  mcpPermissions: FolderMcpPermissions;
}

/** Full kanban board for one folder — six columns pre-grouped. */
export interface KanbanBoard {
  folder: Folder;
  columns: Record<NoteStatus, Note[]>;
}

/** All four booleans gating a folder's MCP exposure. */
export interface FolderMcpPermissions {
  visible: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
}
