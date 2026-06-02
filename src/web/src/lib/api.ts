/**
 * Thin fetch wrapper around the hono REST API. The UI never knows where the
 * data is actually stored — it just talks HTTP to 127.0.0.1.
 *
 * `api` is a barrel composed of per-domain client modules under `./api/`:
 *
 *   - notes         note CRUD, trash, archive, revisions, comments,
 *                   activity feed, attachments, status history, metadata
 *   - folders       folder CRUD, kanban, MCP permissions, view mode
 *   - tags          tag CRUD
 *   - search        workspace-wide search
 *   - settings      workspace settings, runtime, audit, usage, terms,
 *                   Mo memory, MCP-client install, license
 *   - concierge     Mo Concierge: sessions, messages, budget, provider,
 *                   personality, pipeline-models, folder Mo settings
 *   - autocode      Auto-Code workflow runner: runs, budget, merge,
 *                   conflict resolve, transcript, workflows, preflight
 *   - mo            Mo Indexing per-folder surfaces: topics, catalog,
 *                   risks, logs, finding acks
 *   - import        Markdown + Apple Notes import endpoints
 *
 * Types mirror the core `Note`/`Folder`/`Tag` shapes from
 * `src/core/notes/types.ts`. We redeclare them in `./api/types` so the
 * web bundle doesn't cross the architecture boundary (src/web must not
 * import src/core directly).
 *
 * Existing downstream code can keep importing from `'../lib/api'` — types
 * are re-exported via `export *` and methods are spread into the `api`
 * const. New code should import the per-domain module directly.
 */

import { autocodeApi } from './api/autocode';
import { conciergeApi } from './api/concierge';
import { foldersApi } from './api/folders';
import { importApi } from './api/import';
import { moApi } from './api/mo';
import { notesApi } from './api/notes';
import { searchApi } from './api/search';
import { settingsApi } from './api/settings';
import { tagsApi } from './api/tags';

export * from './api/types';

export const api = {
  ...notesApi,
  ...foldersApi,
  ...tagsApi,
  ...searchApi,
  ...settingsApi,
  ...conciergeApi,
  ...autocodeApi,
  ...moApi,
  ...importApi,
};
