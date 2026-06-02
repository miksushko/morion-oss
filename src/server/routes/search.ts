import type { Hono } from 'hono';
import { z } from 'zod';
import type { ToolContext } from '../tools/types.js';
import type { SearchHit } from '../../core/search/hybrid.js';

/**
 * ⌘K / HeaderMenu search. Hybrid FTS5 + vector + RRF from
 * `HybridSearch` — the implementation picks one or the other based on
 * whether the embeddings provider is loaded. HTTP layer just forwards
 * the query and pagination.
 *
 * ULID shortcut: the user often pastes a note id from a Mo chat or
 * another tool ("can't find 01KQ1H4YV..."). FTS only indexes title +
 * body, so the id never matches via fulltext. We detect ULID-shaped
 * input, look it up directly, and prepend it to the result list. If
 * the user pastes a partial-but-unique prefix, we also try a prefix
 * match and surface every note whose id starts with the input. No
 * change to the regular keyword path.
 */
const ULID_FULL = /^[0-9A-HJKMNP-TV-Z]{26}$/i; // Crockford base32, no I L O U
const ULID_PREFIX = /^[0-9A-HJKMNP-TV-Z]{6,25}$/i;

export function registerSearchRoutes(app: Hono, ctx: ToolContext): void {
  // `coerce.boolean` treats any non-empty string as truthy ("false" → true),
  // so parse the literal strings we expect from query params instead.
  const booleanParam = z
    .union([z.literal('true'), z.literal('1'), z.literal('false'), z.literal('0')])
    .transform((v) => v === 'true' || v === '1')
    .optional();

  const searchQuerySchema = z.object({
    q: z.string().min(1),
    folderId: z.string().optional(),
    tag: z.string().optional(),
    includeArchived: booleanParam,
    createdAfter: z.coerce.number().int().nonnegative().optional(),
    createdBefore: z.coerce.number().int().nonnegative().optional(),
    updatedAfter: z.coerce.number().int().nonnegative().optional(),
    updatedBefore: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  });

  app.get('/api/search', async (c) => {
    const parsed = searchQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const trimmed = parsed.q.trim();

    const filterParams = {
      folderId: parsed.folderId,
      tag: parsed.tag,
      includeArchived: parsed.includeArchived,
      createdAfter: parsed.createdAfter,
      createdBefore: parsed.createdBefore,
      updatedAfter: parsed.updatedAfter,
      updatedBefore: parsed.updatedBefore,
    };

    const idHits = lookupByIdShortcut(trimmed, parsed.limit, ctx, filterParams);

    const ftsHits = await ctx.search.search(parsed.q, {
      limit: parsed.limit,
      ...filterParams,
    });

    if (idHits.length === 0) return c.json(ftsHits);

    // Merge: id-hits first, then fulltext hits with any duplicate
    // id-hit removed. Cap at the requested limit.
    const seen = new Set(idHits.map((h) => h.note.id));
    const merged: SearchHit[] = [
      ...idHits,
      ...ftsHits.filter((h) => !seen.has(h.note.id)),
    ];
    return c.json(merged.slice(0, parsed.limit));
  });
}

/**
 * Direct id lookup when the query looks like a (whole or partial)
 * ULID. Returns hits in id-prefix order so a unique full id always
 * lands as a single hit. Folder/tag filters from the query string
 * apply — if the id matches but the note is outside the active
 * folder filter, we drop it (matches the user's mental model: "I
 * filtered to this folder, anything else is noise").
 *
 * `score: Infinity` keeps id-hits sorted above any fulltext hit if
 * the caller mixes them in a single ranked list. The shortcut hits
 * never carry a snippet (the user already knows the id; snippet
 * text isn't useful for distinguishing).
 */
interface ShortcutFilters {
  folderId: string | undefined;
  tag: string | undefined;
  includeArchived: boolean | undefined;
  createdAfter: number | undefined;
  createdBefore: number | undefined;
  updatedAfter: number | undefined;
  updatedBefore: number | undefined;
}

function lookupByIdShortcut(
  query: string,
  limit: number,
  ctx: ToolContext,
  filters: ShortcutFilters,
): SearchHit[] {
  const normalized = query.toUpperCase();
  const out: SearchHit[] = [];

  // Full ULID — single direct lookup. Cheaper than a LIKE scan.
  // `getById` with default options excludes trashed (deleted_at IS NULL)
  // — same invariant the keyword path enforces in 4 layers of
  // defence-in-depth (FtsIndex / VecIndex / applyFilters / fetchNotes).
  if (ULID_FULL.test(query)) {
    const note = ctx.notes.getById(normalized);
    if (note && passesFilters(note, filters, ctx)) {
      out.push({ note, score: Infinity, snippet: null });
    }
    return out;
  }

  // Partial ULID prefix (6+ chars). Use a parameterised LIKE — bounded
  // by `limit + 1` to detect "more matches than we showed" without an
  // expensive COUNT. ULID alphabet has no SQL wildcard chars (% _) so
  // direct concatenation is safe; we still keep the parameter binding
  // for hygiene. `deleted_at IS NULL` matches the soft-delete invariant
  // that every other id-returning layer enforces.
  if (ULID_PREFIX.test(query)) {
    const rows = ctx.db
      .prepare<[string, number], { id: string }>(
        `SELECT id FROM notes WHERE id LIKE ? || '%' AND deleted_at IS NULL ORDER BY id ASC LIMIT ?`,
      )
      .all(normalized, limit);
    for (const row of rows) {
      const note = ctx.notes.getById(row.id);
      if (note && passesFilters(note, filters, ctx)) {
        out.push({ note, score: Infinity, snippet: null });
      }
    }
  }
  return out;
}

function passesFilters(
  note: { folderId: string | null; tags: string[]; archivedAt: number | null; createdAt: number; updatedAt: number },
  filters: ShortcutFilters,
  ctx: ToolContext,
): boolean {
  if (filters.folderId && note.folderId !== filters.folderId) return false;
  if (filters.tag && !note.tags.includes(filters.tag)) return false;
  if (!filters.includeArchived) {
    // Note's own archive state.
    if (note.archivedAt !== null) return false;
    // Parent-folder archive state. Without this, a non-archived note
    // inside an archived folder would leak via id-shortcut even though
    // the keyword path's `applyFilters` blocks it via the LEFT JOIN
    // on folders. Same condition both paths must satisfy.
    if (note.folderId !== null) {
      const folder = ctx.folders.getById(note.folderId);
      if (folder && folder.archivedAt !== null) return false;
    }
  }
  if (filters.createdAfter !== undefined && note.createdAt < filters.createdAfter) return false;
  if (filters.createdBefore !== undefined && note.createdAt > filters.createdBefore) return false;
  if (filters.updatedAfter !== undefined && note.updatedAt < filters.updatedAfter) return false;
  if (filters.updatedBefore !== undefined && note.updatedAt > filters.updatedBefore) return false;
  return true;
}
