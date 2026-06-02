import type Database from 'better-sqlite3';

export interface FtsHit {
  noteId: string;
  score: number;
  snippet: string;
}

interface FtsRow {
  id: string;
  score: number;
  snippet: string;
}

/**
 * Wrapper around the notes_fts virtual table. Returns ranked hits with
 * a highlighted snippet. Soft-deleted notes are excluded.
 */
export class FtsIndex {
  constructor(private readonly db: Database.Database) {}

  search(query: string, limit: number): FtsHit[] {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const rows = this.db
      .prepare<[string, number], FtsRow>(
        `SELECT n.id AS id,
                bm25(notes_fts) AS score,
                snippet(notes_fts, 1, '<mark>', '</mark>', '...', 16) AS snippet
         FROM notes_fts
         JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ? AND n.deleted_at IS NULL
         ORDER BY score
         LIMIT ?`,
      )
      .all(sanitized, limit);

    return rows.map((r) => ({ noteId: r.id, score: r.score, snippet: r.snippet }));
  }
}

/**
 * FTS5 has its own query syntax. Free-form user input can break it
 * (unbalanced quotes, NEAR operators, etc.). We strip everything but
 * letters/digits/whitespace and quote each token as a prefix match.
 */
function sanitizeFtsQuery(raw: string): string {
  const cleaned = raw
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (cleaned.length === 0) return '';
  return cleaned.map((t) => `"${t}"*`).join(' ');
}
