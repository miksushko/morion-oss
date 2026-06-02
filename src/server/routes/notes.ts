import type { Hono } from 'hono';
import type { ToolContext } from '../tools/types.js';
import { registerNotesListRoute } from './notes/list.js';
import { registerNotesTrashRoutes } from './notes/trash.js';
import { registerNotesMetadataRoutes } from './notes/metadata.js';
import { registerNotesCrudRoutes } from './notes/crud.js';
import { registerNotesArchiveRoutes } from './notes/archive.js';
import { registerNotesRevisionsRoutes } from './notes/revisions.js';

/**
 * Notes CRUD + trash + revisions + metadata + archive.
 *
 * Composition shell — per the 2026-05-16 split (Morion ticket
 * 01KRR8J8ED8E8QE37W3QRBP8G7), each route family lives in a sibling
 * module under `./notes/`. **CRITICAL: registration order pinned**
 * by Hono trie semantics — the literal `/api/notes/trash` segment
 * must register before any `/api/notes/:id`-shaped route so it
 * doesn't get captured as an id parameter.
 *
 * Order (matches pre-split file):
 *   1. list      — `GET /api/notes`
 *   2. trash     — `GET/DELETE /api/notes/trash` (literal segment)
 *   3. metadata  — `GET/PATCH /api/notes/:id/metadata` + `PUT /:id/clusters`
 *   4. crud      — `GET/POST/PATCH/DELETE /api/notes[/:id[/purge|restore]]`
 *   5. archive   — `POST /api/notes/:id/archive|unarchive`
 *   6. revisions — `GET/POST /api/notes/:id/revisions[/:revId/restore]`
 */
export function registerNoteRoutes(app: Hono, ctx: ToolContext): void {
  registerNotesListRoute(app, ctx);
  registerNotesTrashRoutes(app, ctx);
  registerNotesMetadataRoutes(app, ctx);
  registerNotesCrudRoutes(app, ctx);
  registerNotesArchiveRoutes(app, ctx);
  registerNotesRevisionsRoutes(app, ctx);
}
