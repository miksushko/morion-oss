/**
 * Types barrel for the frontend HTTP client.
 *
 * Re-exports every type from per-domain modules under `./types/`. The
 * api.ts top-level barrel keeps re-exporting from here, so downstream
 * code can keep importing from `'../lib/api'` unchanged.
 *
 * Domain modules:
 *   - notes      Note, NoteStatus, NoteComment, ActivityRow, NoteRevision,
 *                NoteMcpPermissions, NoteMetadataPayload, etc.
 *   - folders    Folder, FolderViewMode, FolderMcpPermissions, KanbanBoard
 *   - tags       Tag
 *   - search     SearchHit
 *   - settings   workspace MCP, comments, terms, runtime, install, audit
 *   - mo         FolderTopic / FolderCatalog / FolderRisks / FolderLogs /
 *                topic cleanup envelopes / finding acks
 *   - concierge  provider, per-pipeline model overrides, per-folder Mo
 *                settings, sessions, messages, budget
 *   - autocode   workflow runner: queue rows, merge envelopes, transcripts,
 *                workflow CRUD, preflight, budget
 *   - usage      LLM spend aggregations
 *
 * Cross-imports between sub-modules are minimal and one-directional:
 *   folders → notes    (Note + NoteStatus in KanbanBoard)
 *   search  → notes    (Note in SearchHit)
 *   usage   → concierge, autocode  (cap-status fields)
 */

export * from './types/notes';
export * from './types/folders';
export * from './types/tags';
export * from './types/search';
export * from './types/settings';
export * from './types/mo';
export * from './types/concierge';
export * from './types/autocode';
export * from './types/usage';
