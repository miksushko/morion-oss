import type Database from 'better-sqlite3';
import type {
  ActivityCursor,
  ActivityPage,
  ActivityRow,
} from '../notes/comments-types.js';

/**
 * Unified activity feed for a single note (Direction Q).
 *
 * Server-side UNION of two independent streams:
 *   - `audit_log` rows (create / update / delete / status_change / comment_delete)
 *   - `note_comments` rows (top-level + replies)
 *
 * The UI renders a single chronological stream, so the server does the
 * UNION + sort + pagination in one query rather than two round-trips +
 * client merge. Upside:
 *   - Single cursor (no «which stream do I paginate next» confusion)
 *   - Permission filtering is applied once upstream (caller's concern)
 *   - `X-Total-Count` is accurate — it's a COUNT over the same UNION
 *
 * Cursor shape: `(ts, key)` where `key = 'e:<audit_id>' | 'c:<comment_id>'`.
 * String key keeps the SQL simple (no discriminator column, just one
 * compound WHERE) and handles same-ms ties between events and comments
 * deterministically.
 *
 * Overfetch pattern: fetch `limit + 1` rows to know whether another page
 * exists without a second query. Same technique as
 * `NoteCommentsRepository.list` — see comment there for rationale.
 */
export function listActivityForNote(
  db: Database.Database,
  noteId: string,
  opts: { limit: number; before?: ActivityCursor } = { limit: 20 },
): ActivityPage {
  const limit = Math.max(1, Math.min(opts.limit, 500));
  const overfetch = limit + 1;

  // Two subqueries UNION'd. Each row emits the same columns (using NULLs
  // for the other stream's fields) so the outer cursor WHERE + ORDER BY
  // can run over the combined result set.
  //
  // `sort_key` is the synthetic tie-break for rows that share a ts.
  // Prefix scheme is UX-driven: on same-ms ties, comments should appear
  // NEWER than events (the user/agent commented AFTER the event fired,
  // not before). Newest-first display means comments above events on
  // ties. To get that with `ORDER BY sort_key DESC`, comments need a
  // lexicographically-greater prefix than events — hence `z:` vs `a:`.
  //
  // Within each prefix, the inner id tie-breaks deterministically:
  // numeric audit id grows monotonically, ulid comments also grow
  // monotonically (monotonicFactory). So pagination is stable at any
  // cursor depth — no row is ever skipped or duplicated across pages.
  const baseSql = `
    WITH unioned AS (
      SELECT
        'event'                    AS kind,
        a.ts                       AS ts,
        'a:' || CAST(a.id AS TEXT) AS sort_key,
        a.id                       AS event_id,
        a.action                   AS action,
        a.actor                    AS actor,
        a.status_from              AS status_from,
        a.status_to                AS status_to,
        NULL                       AS comment_id,
        NULL                       AS parent_id,
        NULL                       AS body,
        NULL                       AS updated_at
      FROM audit_log a
      WHERE a.note_id = @noteId

      UNION ALL

      SELECT
        'comment'                  AS kind,
        c.created_at               AS ts,
        'z:' || c.id               AS sort_key,
        NULL                       AS event_id,
        NULL                       AS action,
        c.actor                    AS actor,
        NULL                       AS status_from,
        NULL                       AS status_to,
        c.id                       AS comment_id,
        c.parent_id                AS parent_id,
        c.body                     AS body,
        c.updated_at               AS updated_at
      FROM note_comments c
      WHERE c.note_id = @noteId
    )
    SELECT kind, ts, sort_key, event_id, action, actor, status_from, status_to,
           comment_id, parent_id, body, updated_at
    FROM unioned
  `;

  const orderLimit = `ORDER BY ts DESC, sort_key DESC LIMIT @overfetch`;

  interface UnionRow {
    kind: 'event' | 'comment';
    ts: number;
    sort_key: string;
    event_id: number | null;
    action: string | null;
    actor: string;
    status_from: string | null;
    status_to: string | null;
    comment_id: string | null;
    parent_id: string | null;
    body: string | null;
    updated_at: number | null;
  }

  const rows: UnionRow[] = opts.before
    ? (db
        .prepare(
          `${baseSql}
           WHERE ts < @cursorTs OR (ts = @cursorTs AND sort_key < @cursorKey)
           ${orderLimit}`,
        )
        .all({
          noteId,
          overfetch,
          cursorTs: opts.before.ts,
          cursorKey: opts.before.key,
        }) as UnionRow[])
    : (db
        .prepare(`${baseSql} ${orderLimit}`)
        .all({ noteId, overfetch }) as UnionRow[]);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items: ActivityRow[] = pageRows.map((r) => rowToActivity(r, noteId));
  const last = pageRows[pageRows.length - 1];
  const nextCursor: ActivityCursor | null =
    hasMore && last ? { ts: last.ts, key: last.sort_key } : null;
  return { items, nextCursor };
}

/**
 * Total activity row count for a note. Single UNION ALL count — cheap
 * because both tables are indexed on `note_id`.
 *
 * Used by the HTTP `X-Total-Count` header for the UI's "Show N events"
 * label and infinite-scroll bookkeeping.
 */
export function countActivityForNote(db: Database.Database, noteId: string): number {
  const row = db
    .prepare<{ noteId: string }, { c: number }>(
      `SELECT
         (SELECT COUNT(*) FROM audit_log     WHERE note_id = @noteId) +
         (SELECT COUNT(*) FROM note_comments WHERE note_id = @noteId) AS c`,
    )
    .get({ noteId });
  return row?.c ?? 0;
}

function rowToActivity(
  r: {
    kind: 'event' | 'comment';
    ts: number;
    event_id: number | null;
    action: string | null;
    actor: string;
    status_from: string | null;
    status_to: string | null;
    comment_id: string | null;
    parent_id: string | null;
    body: string | null;
    updated_at: number | null;
  },
  noteId: string,
): ActivityRow {
  if (r.kind === 'event') {
    // Defensive — action comes from a text column and could be a future
    // value we don't yet model. Narrow what we handle; pass through the
    // rest as-is via the string typing on ActivityRow's `action`.
    return {
      kind: 'event',
      action: (r.action ?? 'update') as ActivityRow extends { kind: 'event' }
        ? ActivityRow['action']
        : never,
      noteId,
      actor: r.actor,
      ts: r.ts,
      ...(r.status_from ? { statusFrom: r.status_from } : {}),
      ...(r.status_to ? { statusTo: r.status_to } : {}),
    };
  }
  return {
    kind: 'comment',
    id: r.comment_id!,
    noteId,
    parentId: r.parent_id,
    body: r.body ?? '',
    actor: r.actor,
    createdAt: r.ts,
    updatedAt: r.updated_at,
  };
}
