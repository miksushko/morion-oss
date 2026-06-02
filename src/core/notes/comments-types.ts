import { z } from 'zod';

/**
 * A single comment posted against a note. Body is markdown with the same
 * `morion://attachment/<ulid>` convention as note bodies (Direction P).
 *
 * `actor` follows the audit_log convention: `'user'` for UI posts, `'mcp:<san>'`
 * for MCP-client posts (san = the sanitized MCP client name — see
 * `src/server/mcp.ts:43-46`). Same sanitization invariant: whitelist
 * `[a-zA-Z0-9_-]`, max 64 chars, `mcp:unknown` fallback.
 *
 * `parentId` is non-null for 1-level replies. Reply-to-reply is rejected at
 * the repo level (`NoteCommentsRepository.create`) — we don't use a SQL CHECK
 * because cross-row checks in SQLite need a trigger and the repo already does
 * the parent lookup to validate anyway.
 *
 * `updatedAt` is null on a freshly-created comment and set to `Date.now()`
 * only when someone edits the body. The UI uses it to render «edited» badges.
 */
export interface NoteComment {
  id: string;
  noteId: string;
  parentId: string | null;
  body: string;
  actor: string;
  createdAt: number;
  updatedAt: number | null;
}

/**
 * Compound cursor for paginating comments. Monotonic ulid doesn't guarantee
 * cross-process ordering within the same millisecond, so we tie-break on
 * `id` to keep pagination deterministic even when a chatty agent + a user
 * post in the same tick. Serialised as `"ts.id"` for HTTP/MCP transport.
 */
export interface CommentCursor {
  ts: number;
  id: string;
}

/**
 * Cursor-paginated list result. `nextCursor` is the `(ts, id)` of the
 * oldest item in this page; pass it as `before` to fetch the next older
 * page. `null` when there's no older data.
 */
export interface NoteCommentListPage {
  items: NoteComment[];
  nextCursor: CommentCursor | null;
}

/** Encode cursor for URL / MCP response. `"1776497094336.01KPFV8ZQKCYW0GJ9WF3YVJAG1"` */
export function encodeCommentCursor(c: CommentCursor): string {
  return `${c.ts}.${c.id}`;
}

/** Decode a cursor string. Returns null on malformed input — caller treats as "no cursor". */
export function decodeCommentCursor(raw: string): CommentCursor | null {
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const ts = Number(raw.slice(0, dot));
  const id = raw.slice(dot + 1);
  if (!Number.isFinite(ts) || ts < 0) return null;
  if (id.length === 0) return null;
  return { ts, id };
}

/**
 * Compound cursor for the activity UNION. Tie-break key prefixes the
 * source so the UNION'd ordering stays deterministic when an event and
 * a comment share the same millisecond: events get `a:<numeric-id>`,
 * comments get `z:<ulid>`. Prefix scheme is UX-driven: on same-ms ties,
 * comments should sort newer than events (the user commented AFTER the
 * event fired). `ORDER BY sort_key DESC` + 'z' > 'a' achieves that.
 *
 * Serialised as `"ts.key"` for HTTP/MCP transport.
 */
export interface ActivityCursor {
  ts: number;
  key: string; // `a:<audit_id>` | `z:<comment_id>`
}

export interface ActivityPage {
  items: ActivityRow[];
  nextCursor: ActivityCursor | null;
}

/** Matches CommentCursor's format. `"1776497094336.a:42"` / `"1776497094336.z:01K..."`. */
export function encodeActivityCursor(c: ActivityCursor): string {
  return `${c.ts}.${c.key}`;
}

export function decodeActivityCursor(raw: string): ActivityCursor | null {
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const ts = Number(raw.slice(0, dot));
  const key = raw.slice(dot + 1);
  if (!Number.isFinite(ts) || ts < 0) return null;
  if (key.length < 3) return null; // shortest is `a:1` / `z:<26-char ulid>`
  if (!key.startsWith('a:') && !key.startsWith('z:')) return null;
  return { ts, key };
}

/**
 * UNION row returned by the activity-feed endpoint (Q2). Defined here so the
 * Q1 repo and Q2 HTTP route share a single type — the shape is stable even
 * before the route lands.
 *
 * `kind: 'event'` rows come from `audit_log`. `kind: 'comment'` rows come
 * from `note_comments`. Consumer discriminates on `kind`.
 */
export type ActivityRow =
  | {
      kind: 'event';
      action: 'create' | 'update' | 'delete' | 'status_change' | 'comment_delete';
      noteId: string;
      actor: string;
      ts: number;
      statusFrom?: string;
      statusTo?: string;
    }
  | {
      kind: 'comment';
      id: string;
      noteId: string;
      parentId: string | null;
      body: string;
      actor: string;
      createdAt: number;
      updatedAt: number | null;
    };

/**
 * Max body size for a single comment. 50 KB absorbs long paragraphs + a few
 * embedded screenshot refs (`morion://attachment/<id>`, not inlined bytes)
 * without letting the accidental «paste the full build log» bomb land in
 * SQLite. Mirrors the Direction P attachment cap philosophy: user-facing
 * content has a generous-but-finite limit, enforced at zod boundary + repo.
 */
export const COMMENT_BODY_MAX = 50_000;

/** Schema for `POST /api/notes/:id/comments {body, parentId?}` + `notes_add_comment`. */
export const commentCreateSchema = z.object({
  body: z.string().min(1).max(COMMENT_BODY_MAX),
  parentId: z.string().min(1).nullable().optional(),
});

/** Schema for `PATCH /api/comments/:id {body}` + `notes_update_comment`. */
export const commentUpdateSchema = z.object({
  body: z.string().min(1).max(COMMENT_BODY_MAX),
});

/** Thrown when `create` is called with a `parentId` that itself has a non-null
 *  `parent_id` — we allow at most one level of nesting. Caller translates to
 *  HTTP 400 / MCP error envelope. */
export class NestedReplyError extends Error {
  constructor(parentId: string) {
    super(`replies to replies are not allowed (parent ${parentId} is itself a reply)`);
    this.name = 'NestedReplyError';
  }
}

/** Thrown when `update` / `delete` is called with an `actor` that doesn't
 *  match the comment's own `actor`. Defense-in-depth: the Q2 auth gate
 *  already does this check, but the repo enforces it too so no higher-level
 *  bypass can let `mcp:claude-desktop` edit a `user` post. */
export class CommentActorMismatchError extends Error {
  constructor(expected: string, got: string) {
    super(`comment actor mismatch: expected ${expected}, got ${got}`);
    this.name = 'CommentActorMismatchError';
  }
}
