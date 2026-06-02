import type Database from 'better-sqlite3';

/**
 * Mo Indexing Redesign — Tier 0 deterministic checkers.
 *
 * Pure SQL, zero LLM calls. Runs over a single folder and produces
 * typed findings that flow into `mo:patrol-log` and feed the LLM-based
 * `mo:risks` synthesis (Phase 4) without burning tokens for the
 * obvious stuff.
 *
 * Each check is its own function so callers can run a subset (e.g. a
 * daily cron may want only `findStuckTickets` for time-aging detection
 * while the per-edit event flow runs everything else).
 *
 * Caller discipline:
 * - Skip archived/deleted folders before calling (`folder.archived_at
 *   IS NULL AND folder.deleted_at IS NULL`).
 * - All checks filter notes by `deleted_at IS NULL AND archived_at IS
 *   NULL` so soft-deleted + archived notes don't show up as findings.
 * - `now` is injected so tests can pin time without the system clock.
 */

export type Tier0FindingKind =
  | 'stuck_doing'
  | 'stuck_review'
  | 'no_tags'
  | 'short_body'
  | 'broken_title_strikethrough'
  | 'broken_title_overlong';

export type FindingSeverity = 'info' | 'warn' | 'p2' | 'p1';

export interface Tier0Finding {
  kind: Tier0FindingKind;
  severity: FindingSeverity;
  noteId: string;
  noteTitle: string;
  message: string;
  /** Extra context for `mo:patrol-log` rendering (kind-specific). */
  context: Record<string, unknown>;
}

export interface Tier0Options {
  /** Days a ticket can sit in `doing` before flagged as stuck. Default 14. */
  stuckDoingDays?: number;
  /** Days a ticket can sit in `review` before flagged as stuck. Default 7. */
  stuckReviewDays?: number;
  /** Min body length (chars) to be considered substantial. Default 50. */
  minBodyChars?: number;
  /** Max chars on the first non-empty line of body before flagged. Default 200. */
  maxTitleLineChars?: number;
  /** Override Date.now for tests. */
  now?: number;
}

interface NoteRow {
  id: string;
  folder_id: string | null;
  body: string;
  status: string;
  updated_at: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Run every Tier 0 check against one folder; concat all findings.  */
export function runTier0Checks(
  db: Database.Database,
  folderId: string,
  options: Tier0Options = {},
): Tier0Finding[] {
  const findings: Tier0Finding[] = [];
  findings.push(...findStuckTickets(db, folderId, options));
  findings.push(...findUntaggedNotes(db, folderId, options));
  findings.push(...findShortBodies(db, folderId, options));
  findings.push(...findBrokenTitles(db, folderId, options));
  return findings;
}

/** Time-aging check — kanban tickets parked in `doing` / `review` past the
 *  configured threshold. Daily-cron territory in the trigger model.  */
export function findStuckTickets(
  db: Database.Database,
  folderId: string,
  options: Tier0Options = {},
): Tier0Finding[] {
  const stuckDoingMs = (options.stuckDoingDays ?? 14) * DAY_MS;
  const stuckReviewMs = (options.stuckReviewDays ?? 7) * DAY_MS;
  const now = options.now ?? Date.now();

  const rows = db
    .prepare<[string, string, string], NoteRow>(
      `SELECT id, folder_id, body, status, updated_at
         FROM notes
        WHERE folder_id = ?
          AND deleted_at IS NULL
          AND archived_at IS NULL
          AND status IN (?, ?)`,
    )
    .all(folderId, 'doing', 'review');

  const findings: Tier0Finding[] = [];
  for (const row of rows) {
    const ageMs = now - row.updated_at;
    if (row.status === 'doing' && ageMs >= stuckDoingMs) {
      const days = Math.floor(ageMs / DAY_MS);
      findings.push({
        kind: 'stuck_doing',
        severity: days >= 30 ? 'p1' : 'p2',
        noteId: row.id,
        noteTitle: titleOf(row.body),
        message: `Ticket has been in "doing" for ${days} days without an update.`,
        context: { ageDays: days, status: row.status, lastUpdate: row.updated_at },
      });
    } else if (row.status === 'review' && ageMs >= stuckReviewMs) {
      const days = Math.floor(ageMs / DAY_MS);
      findings.push({
        kind: 'stuck_review',
        severity: days >= 14 ? 'p1' : 'p2',
        noteId: row.id,
        noteTitle: titleOf(row.body),
        message: `Ticket has been in "review" for ${days} days without an update.`,
        context: { ageDays: days, status: row.status, lastUpdate: row.updated_at },
      });
    }
  }
  return findings;
}

/** Notes with zero tags. Often signals "I forgot to tag this" or "this
 *  is junk that shouldn't be a permanent note". Low severity by
 *  default — the user often legitimately keeps untagged scratch notes. */
export function findUntaggedNotes(
  db: Database.Database,
  folderId: string,
  _options: Tier0Options = {},
): Tier0Finding[] {
  const rows = db
    .prepare<[string], NoteRow>(
      `SELECT n.id, n.folder_id, n.body, n.status, n.updated_at
         FROM notes n
         LEFT JOIN note_tags nt ON nt.note_id = n.id
        WHERE n.folder_id = ?
          AND n.deleted_at IS NULL
          AND n.archived_at IS NULL
          AND nt.tag_id IS NULL
          AND LENGTH(n.body) > 50`,
    )
    .all(folderId);

  return rows.map((row) => ({
    kind: 'no_tags' as const,
    severity: 'info' as const,
    noteId: row.id,
    noteTitle: titleOf(row.body),
    message: 'Note has no tags. Consider classifying for easier retrieval.',
    context: { status: row.status },
  }));
}

/** Body shorter than `minBodyChars` is probably a stub. Surface so user
 *  can flesh it out or delete. */
export function findShortBodies(
  db: Database.Database,
  folderId: string,
  options: Tier0Options = {},
): Tier0Finding[] {
  const minChars = options.minBodyChars ?? 50;
  const rows = db
    .prepare<[string, number], NoteRow>(
      `SELECT id, folder_id, body, status, updated_at
         FROM notes
        WHERE folder_id = ?
          AND deleted_at IS NULL
          AND archived_at IS NULL
          AND LENGTH(body) < ?`,
    )
    .all(folderId, minChars);

  return rows.map((row) => ({
    kind: 'short_body' as const,
    severity: 'info' as const,
    noteId: row.id,
    noteTitle: titleOf(row.body),
    message: `Note body is only ${row.body.length} chars — looks like a stub.`,
    context: { length: row.body.length, threshold: minChars, status: row.status },
  }));
}

/** First-line title heuristics:
 *  - first non-empty line starts with `~~` → strikethrough title (precedent
 *    from `Morion Features` ticket where strikethrough hid the real intent)
 *  - first non-empty line longer than `maxTitleLineChars` → unwieldy title
 *    that breaks compact lists / agent retrieval */
export function findBrokenTitles(
  db: Database.Database,
  folderId: string,
  options: Tier0Options = {},
): Tier0Finding[] {
  const maxChars = options.maxTitleLineChars ?? 200;
  const rows = db
    .prepare<[string], NoteRow>(
      `SELECT id, folder_id, body, status, updated_at
         FROM notes
        WHERE folder_id = ?
          AND deleted_at IS NULL
          AND archived_at IS NULL
          AND body != ''`,
    )
    .all(folderId);

  const findings: Tier0Finding[] = [];
  for (const row of rows) {
    const firstLine = firstNonEmptyLine(row.body);
    if (!firstLine) continue;

    if (firstLine.startsWith('~~')) {
      findings.push({
        kind: 'broken_title_strikethrough',
        severity: 'warn',
        noteId: row.id,
        noteTitle: titleOf(row.body),
        message:
          'Title line is struck through — derived title is misleading. Rewrite the first line.',
        context: { firstLine: firstLine.slice(0, 200), status: row.status },
      });
    } else if (firstLine.length > maxChars) {
      findings.push({
        kind: 'broken_title_overlong',
        severity: 'info',
        noteId: row.id,
        noteTitle: titleOf(row.body),
        message: `Title line is ${firstLine.length} chars — agents may struggle to scan it.`,
        context: {
          firstLineLength: firstLine.length,
          threshold: maxChars,
          status: row.status,
        },
      });
    }
  }
  return findings;
}

/** Derive a short display title from a body — same rule as the rest of
 *  the codebase: first non-empty line, leading markdown markers stripped,
 *  truncated. Used for finding messages and logs where the canonical
 *  Note row isn't loaded. */
function titleOf(body: string): string {
  const line = firstNonEmptyLine(body) ?? '';
  // Strip markdown: leading `#`/`-`/`*` markers, trailing whitespace.
  const cleaned = line.replace(/^[#\-*\s>]+/, '').trim();
  if (cleaned.length <= 80) return cleaned;
  return cleaned.slice(0, 77) + '...';
}

function firstNonEmptyLine(body: string): string | null {
  for (const raw of body.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}
