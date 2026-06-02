/**
 * Regression: production folder reorder broken whenever the workspace
 * has any nested folders. The sidebar (`FolderTree.tsx`) renders every
 * folder flat — it groups by `view_mode` only, no parent/child nesting
 * UI exists — so a "child" folder (one whose `parent_id` points at a
 * real existing folder) appears in the same visual list as its parent
 * and the null-parent siblings around it. The server's
 * `FoldersRepository.move()` USED to filter siblings by
 * `parent_id IS ? AND view_mode = ?`. That made Move Up on a row whose
 * visual neighbour was actually a folder with a DIFFERENT parent_id
 * return 404 "at boundary" — the child group thought it had no
 * sibling above, even though the user saw one one row up.
 *
 * Real-world example from the user's DB: top-level `Ariel-migration-plan`
 * folder (parent_id=NULL) had three child folders (docs 4, docs (Copy),
 * skills, all parent_id=Ariel.id). The sidebar rendered them
 * intermixed with null-parent folders, but Move Up on `repro-switch-bug`
 * (a null-parent row visually below the three children) returned 404
 * because its filtered siblings list was [repro-switch-bug, Charlie,
 * Bkt UI 2, ...] putting it at index 0 — boundary.
 *
 * Fix: drop the `parent_id` filter from the move() sibling query.
 * Group by `view_mode` only, matching what the UI shows.
 *
 * Ticket: 01KRZAC71PANN4XVGMB3TBGV75
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { FoldersRepository } from '../src/core/folders/repository.js';

describe('FoldersRepository.move() with mixed parent_ids (01KRZAC71PANN4XVGMB3TBGV75)', () => {
  let handle: DbHandle;
  let db: Database.Database;
  let repo: FoldersRepository;

  beforeEach(() => {
    handle = openDb({ path: ':memory:' });
    db = handle.db;
    repo = new FoldersRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('swaps null-parent neighbours past a nested-child row in between', () => {
    // Seed three list folders that all render at the top level in
    // the sidebar: a null-parent root, a child of `parent` rendered
    // intermixed because the UI is flat, and a second null-parent
    // row. The user's DB hits this exact shape every time they nest
    // anything.
    db.exec(`
      INSERT INTO folders (id, name, parent_id, position, created_at) VALUES
        ('parent', 'Parent', NULL, 0, 0),
        ('a', 'A', NULL, 1, 0),
        ('child', 'Child', 'parent', 2, 0),
        ('b', 'B', NULL, 3, 0);
    `);

    // Before the fix: siblings(b) filtered to parent_id IS NULL +
    // view_mode='list' = [parent(0), a(1), b(3)]. b's index = 2, up →
    // swap with a(1). So a "B up" jumped PAST Child — the visible
    // neighbour was ignored. After the fix b's siblings include all
    // four rows in their visible order — Up swaps with the actual
    // visible neighbour Child.
    const ok = repo.move('b', -1);
    expect(ok).toBe(true);

    const rows = db
      .prepare<[], { id: string; position: number }>(
        'SELECT id, position FROM folders ORDER BY position',
      )
      .all();
    expect(rows).toEqual([
      { id: 'parent', position: 0 },
      { id: 'a', position: 1 },
      { id: 'b', position: 2 },
      { id: 'child', position: 3 },
    ]);
  });

  it('returns false at the true visible top, not the same-parent top', () => {
    // Before the fix: a child in position 1 would be considered "at
    // boundary" against its own parent group (single-member siblings
    // list, because Parent itself was excluded by the filter). After
    // the fix the visible top is the position-0 row from the full
    // view-mode group — the child can climb past Parent.
    db.exec(`
      INSERT INTO folders (id, name, parent_id, position, created_at) VALUES
        ('parent', 'Parent', NULL, 0, 0),
        ('child', 'Child', 'parent', 1, 0);
    `);
    expect(repo.move('parent', -1)).toBe(false); // parent is the visible top
    expect(repo.move('child', -1)).toBe(true); // child climbs past parent
  });

  it('self-heals position collisions instead of swapping 0↔0 = no-op', () => {
    // Real-world DB state observed in a user's prod app: three sibling
    // folders all sat at `position = 0` (likely seeded by a bulk import
    // that bypassed `nextPosition()`). The old swap-positions move()
    // wrote `swap.position` onto `id` and vice versa — when both
    // positions matched, the swap was 0↔0 and ORDER BY position, name
    // re-rendered the same order. Move Up/Down silently failed and
    // the user thought the menu was broken. Drag-reorder happened to
    // dodge this because `reorder()` writes dense sequential
    // positions, but the WKWebView drag bug shipped at the same time
    // and prevented users from triggering that recovery path.
    //
    // After the fix move() builds an ordered-ids array, swaps the two
    // indices, and pipes through reorder() — so the first menu click
    // both normalises positions AND moves the row.
    db.exec(`
      INSERT INTO folders (id, name, parent_id, position, created_at) VALUES
        ('a', 'Mo Architecture Notes', NULL, 0, 0),
        ('b', 'Mo Lessons',            NULL, 0, 0),
        ('c', 'Morion Commands',       NULL, 0, 0);
    `);

    // Move "Mo Lessons" (visually row 2 by alphabetical tiebreaker) up.
    expect(repo.move('b', -1)).toBe(true);

    const rows = db
      .prepare<[], { id: string; position: number }>(
        'SELECT id, position FROM folders ORDER BY position, name',
      )
      .all();
    expect(rows).toEqual([
      { id: 'b', position: 0 },
      { id: 'a', position: 1 },
      { id: 'c', position: 2 },
    ]);
  });

  it('still separates list and kanban groups', () => {
    // view_mode IS still a filter — a list folder must not swap with
    // a kanban folder. The sidebar renders them under their own
    // section headers so cross-group swaps would be silent to the
    // user.
    db.exec(`
      INSERT INTO folders (id, name, parent_id, position, created_at, view_mode) VALUES
        ('list_a', 'ListA', NULL, 1, 0, 'list'),
        ('kanban_a', 'KanbanA', NULL, 2, 0, 'kanban');
    `);
    // list_a has no list siblings above it → at boundary.
    expect(repo.move('list_a', -1)).toBe(false);
    // kanban_a has no kanban siblings above it either.
    expect(repo.move('kanban_a', -1)).toBe(false);
  });
});
