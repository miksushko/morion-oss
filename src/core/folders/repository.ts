import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type { Folder, FolderMcpPermissions, FolderViewMode } from '../notes/types.js';

interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  position: number;
  created_at: number;
  view_mode: string;
  archived_at: number | null;
  note_count: number;
  mcp_visible: number;
  mcp_create: number;
  mcp_update: number;
  mcp_delete: number;
}

export class FoldersRepository {
  constructor(private readonly db: Database.Database) {}

  create(name: string, parentId: string | null = null): Folder {
    const id = ulid();
    const now = Date.now();
    const position = this.nextPosition(parentId);
    this.db
      .prepare(
        'INSERT INTO folders (id, name, parent_id, position, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, name, parentId, position, now);
    // New folders inherit the schema-default mcp permissions (all true) and
    // view_mode = 'list'. The latter is the default behaviour — a freshly
    // created folder is a plain note list until the user flips it to kanban.
    return {
      id,
      name,
      parentId,
      position,
      createdAt: now,
      viewMode: 'list',
      archivedAt: null,
      noteCount: 0,
      mcpPermissions: { visible: true, create: true, update: true, delete: true },
    };
  }

  /**
   * Every read of a folder carries `noteCount` so the sidebar can render the
   * `(N)` badge without a second query. The LEFT JOIN keeps empty folders in
   * the result set, and `deleted_at IS NULL` filters out soft-deleted notes.
   */
  // Phase 6.7 v2 — `mo:*` system notes (catalog, cluster:<theme>,
  // risks, patrol-log) are filtered from user-facing list / search;
  // folder noteCount badges have to stay consistent with that filter
  // or the sidebar reads "20 notes" while the list shows 8. The
  // JOIN excludes them at the count layer too.
  private static readonly SELECT_WITH_COUNT = `
    SELECT
      f.id, f.name, f.parent_id, f.position, f.created_at, f.view_mode,
      f.archived_at,
      f.mcp_visible, f.mcp_create, f.mcp_update, f.mcp_delete,
      COUNT(n.id) AS note_count
    FROM folders f
    LEFT JOIN notes n ON n.folder_id = f.id
      AND n.deleted_at IS NULL
      AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
  `;

  /**
   * `includeArchived` (default false) decides whether archived folders
   * show up. UI opts in via the "Show Archived" toggle; MCP never opts
   * in — archived folders are hidden from agents even on direct-id
   * access (see MCP tool sites for that guard).
   */
  list(options?: { includeArchived?: boolean }): Folder[] {
    const includeArchived = options?.includeArchived === true;
    const where = includeArchived ? '' : ' WHERE f.archived_at IS NULL ';
    const rows = this.db
      .prepare<[], FolderRow>(
        `${FoldersRepository.SELECT_WITH_COUNT} ${where} GROUP BY f.id ORDER BY f.position, f.name`,
      )
      .all();
    return rows.map(this.rowToFolder);
  }

  getById(id: string): Folder | null {
    const row = this.db
      .prepare<[string], FolderRow>(
        `${FoldersRepository.SELECT_WITH_COUNT} WHERE f.id = ? GROUP BY f.id`,
      )
      .get(id);
    return row ? this.rowToFolder(row) : null;
  }

  /**
   * Look up a folder by its name under a given parent. The importer uses this
   * to idempotently reuse an existing folder instead of creating duplicates on
   * re-runs. We match on `name` only; renaming a folder in the UI will break
   * that idempotence, which is acceptable for MVP.
   */
  getByName(name: string, parentId: string | null = null): Folder | null {
    const row = this.db
      .prepare<[string, string | null], FolderRow>(
        `${FoldersRepository.SELECT_WITH_COUNT} WHERE f.name = ? AND f.parent_id IS ? GROUP BY f.id`,
      )
      .get(name, parentId);
    return row ? this.rowToFolder(row) : null;
  }

  getOrCreate(name: string, parentId: string | null = null): Folder {
    return this.getByName(name, parentId) ?? this.create(name, parentId);
  }

  rename(id: string, name: string): boolean {
    const result = this.db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id);
    return result.changes > 0;
  }

  delete(id: string): boolean {
    // ON DELETE SET NULL on notes/folder_id and ON DELETE SET NULL on parent_id
    // means deleting a folder unfiles its notes (-> Inbox) and orphans children.
    const result = this.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * Return the ids of every non-deleted note directly inside this folder,
   * split by whether the note is user-authored or a Mo-maintained system
   * note (`source LIKE 'mo:%'` — the `mo:catalog`, `mo:cluster:*`, and
   * `mo:patrol-log` indices). Used by the "Delete folder + all notes
   * inside" route handler:
   *   - regular notes go through `ctx.notes.delete` (soft-delete +
   *     audit, restorable from Trash for the normal retention window)
   *   - mo:* notes are HARD-deleted right away — they're machine-
   *     maintained metadata that the user shouldn't have to triage in
   *     Trash, and they'd just get re-indexed if restored without their
   *     parent folder.
   * Ticket `01KQFDZB7C61F5EMKQEKYPP3YA` covers the user-facing flow;
   * the mo:* hard-delete branch was added in response to dogfood
   * showing index notes leaking into Trash.
   */
  noteIdsInside(
    id: string,
  ): { regular: string[]; moSystem: string[] } {
    const rows = this.db
      .prepare(
        "SELECT id, source FROM notes WHERE folder_id = ? AND deleted_at IS NULL",
      )
      .all(id) as Array<{ id: string; source: string | null }>;
    const regular: string[] = [];
    const moSystem: string[] = [];
    for (const row of rows) {
      if (row.source && row.source.startsWith('mo:')) moSystem.push(row.id);
      else regular.push(row.id);
    }
    return { regular, moSystem };
  }

  /**
   * Create an empty `(Copy)` clone of a folder, inserted right after the
   * source in the sidebar order (Apple Notes parity). The note copying
   * itself is orchestrated by `duplicateFolder` in `./duplicate.ts` — this
   * method handles only the folder shell + position bump so it stays a pure
   * folder operation. Returns the new folder, or null if the source is
   * missing.
   */
  duplicateShell(sourceId: string): Folder | null {
    const source = this.getById(sourceId);
    if (!source) return null;

    const newId = ulid();
    const now = Date.now();
    const newName = `${source.name} (Copy)`;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE folders SET position = position + 1 WHERE parent_id IS ? AND position > ?',
        )
        .run(source.parentId, source.position);
      this.db
        .prepare(
          'INSERT INTO folders (id, name, parent_id, position, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(newId, newName, source.parentId, source.position + 1, now);
    });
    tx();

    return this.getById(newId);
  }

  /**
   * Move a folder one slot earlier (delta=-1) or later (delta=+1) in its
   * parent's ordering. Returns false when the folder is missing or already
   * at the boundary. Used by the sidebar more-menu's Move Up/Down items —
   * `reorder()` is fine for drag-and-drop, but for a single-step move it's
   * overkill (and would require the UI to know the full ordered list).
   *
   * Sibling lookup MUST filter by `view_mode` too: the sidebar splits
   * top-level folders into two visual groups (list vs kanban), so a swap
   * with the absolute-position-adjacent folder can land on a sibling from
   * the OTHER group, making the swap silent to the user (the swap happens
   * in DB but neither group's internal order changes visibly).
   *
   * The lookup does NOT filter by `parent_id`. The sidebar renders folders
   * flat — `FolderTree.tsx` only groups by `view_mode`, no nesting UI —
   * so orphaned folders (rows with a stale `parent_id` pointing to a
   * deleted folder, e.g. after a duplicate-then-delete cycle) appear in
   * the same visual group as `parent_id IS NULL` rows. Filtering by
   * `parent_id` here would mis-identify the visible neighbours and return
   * 404 "at boundary" when the user clicks Move Up on a row whose only
   * same-parent sibling sits the other side of an orphan. Ticket
   * 01KRZAC71PANN4XVGMB3TBGV75 — was the reproducible cause of the
   * "production folder reorder doesn't work" reports.
   *
   * Reorder-semantics, not swap-semantics. Earlier the swap path wrote
   * `swap.position` onto `id` and vice versa; when two siblings shared
   * a `position` (legacy DBs imported before `nextPosition()` was
   * tightened, or rows touched by a bulk script that ignored ordering)
   * the swap was 0↔0 = no-op and the user saw Move Up/Down silently
   * fail. Building the full sorted-id list, swapping array indices,
   * and calling `reorder()` writes dense sequential positions in one
   * transaction — self-heals the collision on the first move.
   */
  move(id: string, delta: -1 | 1): boolean {
    const folder = this.getById(id);
    if (!folder) return false;

    const siblings = this.db
      .prepare<[string], { id: string }>(
        'SELECT id FROM folders WHERE view_mode = ? ORDER BY position, name',
      )
      .all(folder.viewMode);

    const index = siblings.findIndex((s) => s.id === id);
    if (index === -1) return false;
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= siblings.length) return false;

    const orderedIds = siblings.map((s) => s.id);
    [orderedIds[index], orderedIds[targetIndex]] = [
      orderedIds[targetIndex]!,
      orderedIds[index]!,
    ];
    this.reorder(orderedIds);
    return true;
  }

  /**
   * Apply a new ordering to a flat list of folder ids. The position of folder
   * `orderedIds[i]` becomes `i`. Wrapped in a single transaction so the UI
   * either sees the full new order or the previous one — never a mid-shuffle
   * mix. Ids missing from the array keep their existing position.
   */
  reorder(orderedIds: string[]): void {
    const stmt = this.db.prepare('UPDATE folders SET position = ? WHERE id = ?');
    const tx = this.db.transaction((ids: string[]) => {
      ids.forEach((id, index) => stmt.run(index, id));
    });
    tx(orderedIds);
  }

  private nextPosition(parentId: string | null): number {
    const row = this.db
      .prepare<[string | null], { max: number | null }>(
        'SELECT MAX(position) AS max FROM folders WHERE parent_id IS ?',
      )
      .get(parentId);
    return (row?.max ?? -1) + 1;
  }

  private rowToFolder(row: FolderRow): Folder {
    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      position: row.position,
      createdAt: row.created_at,
      viewMode: row.view_mode as FolderViewMode,
      archivedAt: row.archived_at,
      noteCount: row.note_count,
      mcpPermissions: {
        visible: row.mcp_visible === 1,
        create: row.mcp_create === 1,
        update: row.mcp_update === 1,
        delete: row.mcp_delete === 1,
      },
    };
  }

  /**
   * Toggle archive state on a folder. Archive = hidden from default
   * sidebar + its notes hidden from lists + MCP; no 7-day purge.
   * Folder.archived does NOT cascade `archived_at` onto the folder's
   * notes (so an Unarchive restores the exact prior state — any
   * individually-archived note stays archived). Note-level list filters
   * honour the folder's archived status regardless.
   */
  setArchived(id: string, archived: boolean): Folder | null {
    const result = archived
      ? this.db
          .prepare(
            'UPDATE folders SET archived_at = ? WHERE id = ? AND archived_at IS NULL',
          )
          .run(Date.now(), id)
      : this.db
          .prepare(
            'UPDATE folders SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL',
          )
          .run(id);
    if (result.changes === 0) return null;
    return this.getById(id);
  }

  /**
   * Direction N — flip a folder between list and kanban mode.
   * Data-preserving: note.status / note.position values survive the flip,
   * they're just not rendered in list mode. Same principle as Pro MCP
   * permissions surviving a Pro→Free downgrade (lessons.md 2026-04-14).
   *
   * No CHECK enforcement in JS — the DB CHECK constraint on `view_mode`
   * already rejects anything outside ('list','kanban'). Returns the
   * updated folder or null if id doesn't exist.
   */
  setViewMode(id: string, mode: FolderViewMode): Folder | null {
    const result = this.db
      .prepare('UPDATE folders SET view_mode = ? WHERE id = ?')
      .run(mode, id);
    if (result.changes === 0) return null;
    return this.getById(id);
  }

  /**
   * Update the MCP permission flags on a folder. All four are required so
   * the caller has explicitly considered each — no partial-update footgun
   * where you mean to flip one and forget another. Returns the updated
   * folder.
   *
   * Pro-tier feature. Free-tier callers should be blocked at the HTTP
   * layer (402) before this is reached; the repository itself doesn't
   * know about license tiers.
   */
  setMcpPermissions(id: string, perms: FolderMcpPermissions): Folder | null {
    const result = this.db
      .prepare(
        'UPDATE folders SET mcp_visible = ?, mcp_create = ?, mcp_update = ?, mcp_delete = ? WHERE id = ?',
      )
      .run(
        perms.visible ? 1 : 0,
        perms.create ? 1 : 0,
        perms.update ? 1 : 0,
        perms.delete ? 1 : 0,
        id,
      );
    if (result.changes === 0) return null;
    return this.getById(id);
  }
}
