import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type { Tag } from '../notes/types.js';

interface TagRow {
  id: string;
  name: string;
  color: string | null;
  note_count: number;
}

export class TagsRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Reads always carry `noteCount` so the sidebar / tag manager can render
   * counts without a second query. The LEFT JOIN keeps tags with zero notes
   * in the result, and `deleted_at IS NULL` filters out soft-deleted notes.
   */
  private static readonly SELECT_WITH_COUNT = `
    SELECT
      t.id, t.name, t.color,
      COUNT(n.id) AS note_count
    FROM tags t
    LEFT JOIN note_tags nt ON nt.tag_id = t.id
    LEFT JOIN notes n ON n.id = nt.note_id AND n.deleted_at IS NULL
  `;

  /** Look up a tag by name, creating it if it doesn't exist. */
  upsertByName(name: string, color: string | null = null): Tag {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Tag name cannot be empty');

    const existing = this.findByName(trimmed);
    if (existing) return existing;

    return this.create(trimmed, color);
  }

  /**
   * Create a tag with an explicit name + color. Throws if a tag with the same
   * name already exists (the unique constraint surfaces as a SQLite error).
   */
  create(name: string, color: string | null = null): Tag {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Tag name cannot be empty');

    const id = ulid();
    this.db.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)').run(id, trimmed, color);
    return { id, name: trimmed, color, noteCount: 0 };
  }

  findByName(name: string): Tag | null {
    const row = this.db
      .prepare<[string], TagRow>(
        `${TagsRepository.SELECT_WITH_COUNT} WHERE t.name = ? GROUP BY t.id`,
      )
      .get(name);
    return row ? this.rowToTag(row) : null;
  }

  getById(id: string): Tag | null {
    const row = this.db
      .prepare<[string], TagRow>(
        `${TagsRepository.SELECT_WITH_COUNT} WHERE t.id = ? GROUP BY t.id`,
      )
      .get(id);
    return row ? this.rowToTag(row) : null;
  }

  list(): Tag[] {
    const rows = this.db
      .prepare<[], TagRow>(
        `${TagsRepository.SELECT_WITH_COUNT} GROUP BY t.id ORDER BY t.name`,
      )
      .all();
    return rows.map(this.rowToTag);
  }

  /**
   * Partial update of a tag. `name` and `color` are both optional; passing
   * `color: null` clears the color. Returns the updated tag, or null if the
   * id is missing.
   */
  update(id: string, patch: { name?: string; color?: string | null }): Tag | null {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) throw new Error('Tag name cannot be empty');
      sets.push('name = ?');
      values.push(trimmed);
    }
    if (patch.color !== undefined) {
      sets.push('color = ?');
      values.push(patch.color);
    }
    if (sets.length === 0) return this.getById(id);

    values.push(id);
    const result = this.db.prepare(`UPDATE tags SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) return null;
    return this.getById(id);
  }

  rename(id: string, newName: string): boolean {
    const result = this.db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(newName.trim(), id);
    return result.changes > 0;
  }

  setColor(id: string, color: string | null): boolean {
    const result = this.db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(color, id);
    return result.changes > 0;
  }

  delete(id: string): boolean {
    // note_tags has ON DELETE CASCADE, so links are removed automatically.
    const result = this.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    return result.changes > 0;
  }

  private rowToTag(row: TagRow): Tag {
    return { id: row.id, name: row.name, color: row.color, noteCount: row.note_count };
  }
}
