import { describe, expect, it } from 'vitest';
import { computeReorderedFolderIds } from '../src/web/src/layout/sidebar/drag-reorder';
import type { Folder } from '../src/web/src/lib/api';

/** Make a minimal Folder fixture. Only the fields the reorder helper
 *  reads are filled in; the rest stay defaultish. */
function f(id: string, viewMode: 'list' | 'kanban' = 'list'): Folder {
  return {
    id,
    name: id,
    position: 0,
    noteCount: 0,
    viewMode,
    archivedAt: null,
    mcpPermissions: { visible: true, create: true, update: true, delete: true },
  } as Folder;
}

describe('computeReorderedFolderIds', () => {
  it('moves a list folder forward within its group', () => {
    const folders = [f('a'), f('b'), f('c'), f('d')];
    expect(computeReorderedFolderIds(folders, 'a', 'c')).toEqual([
      'b',
      'c',
      'a',
      'd',
    ]);
  });

  it('moves a list folder backward within its group', () => {
    const folders = [f('a'), f('b'), f('c'), f('d')];
    expect(computeReorderedFolderIds(folders, 'd', 'b')).toEqual([
      'a',
      'd',
      'b',
      'c',
    ]);
  });

  it('returns null when dragging a folder onto itself (no-op)', () => {
    const folders = [f('a'), f('b')];
    expect(computeReorderedFolderIds(folders, 'a', 'a')).toBe(null);
  });

  it('returns null when the dragged folder is unknown', () => {
    const folders = [f('a'), f('b')];
    expect(computeReorderedFolderIds(folders, 'ghost', 'a')).toBe(null);
  });

  it('returns null when the target folder is unknown', () => {
    const folders = [f('a'), f('b')];
    expect(computeReorderedFolderIds(folders, 'a', 'ghost')).toBe(null);
  });

  it('rejects cross-group drops — list into kanban', () => {
    const folders = [f('a', 'list'), f('k', 'kanban')];
    expect(computeReorderedFolderIds(folders, 'a', 'k')).toBe(null);
  });

  it('rejects cross-group drops — kanban into list', () => {
    const folders = [f('a', 'list'), f('k', 'kanban')];
    expect(computeReorderedFolderIds(folders, 'k', 'a')).toBe(null);
  });

  it('reorders within the kanban group while preserving list neighbors', () => {
    const folders = [
      f('a', 'list'),
      f('b', 'list'),
      f('k1', 'kanban'),
      f('k2', 'kanban'),
      f('k3', 'kanban'),
    ];
    expect(computeReorderedFolderIds(folders, 'k3', 'k1')).toEqual([
      'a',
      'b',
      'k3',
      'k1',
      'k2',
    ]);
  });
});
