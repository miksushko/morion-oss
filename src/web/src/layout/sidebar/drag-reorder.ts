import type { Folder } from '../../lib/api';

/**
 * Resolve a folder-reorder drag-drop into the next folder-id order.
 *
 * Rules (mirroring the legacy `handleFolderDrop` inline logic on
 * Sidebar.tsx, ticket `01KQ2WG1B0XEVV3EKT43357B4H`):
 *
 *   - Dragging onto itself is a no-op → returns null.
 *   - Cross-group drops are rejected — list folders only reorder
 *     within list folders, kanban only within kanban. (Moving a list
 *     folder into the kanban group must happen through the inline
 *     toggle, not drag.) Returns null.
 *   - Source or target missing from `folders` → returns null.
 *
 * Otherwise: splice the dragged id out of the current order and
 * insert it at the target's original index. Same shape the server
 * round-trip (`onReorderFolders(ids)`) expects.
 */
export function computeReorderedFolderIds(
  folders: Folder[],
  draggedId: string,
  targetId: string,
): string[] | null {
  if (draggedId === targetId) return null;
  const source = folders.find((f) => f.id === draggedId);
  const target = folders.find((f) => f.id === targetId);
  if (!source || !target) return null;
  if (source.viewMode !== target.viewMode) return null;

  const ids = folders.map((f) => f.id);
  const fromIndex = ids.indexOf(draggedId);
  const toIndex = ids.indexOf(targetId);
  if (fromIndex === -1 || toIndex === -1) return null;

  ids.splice(fromIndex, 1);
  ids.splice(toIndex, 0, draggedId);
  return ids;
}
