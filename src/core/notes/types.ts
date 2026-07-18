import { z } from 'zod';

export type NoteSource =
  | 'user'
  | `mcp:${string}`
  | `import:${string}`
  // Legacy `mo:brief` notes from the pre-`folder_briefs` Project Brief
  // implementation. The `folder_briefs` table that replaced them was
  // itself dropped in Phase 6.1 (migration 0019); any surviving rows
  // with this source are inert and not consulted by current code.
  | 'mo:brief'
  // Mo Indexing Redesign — append-only deterministic-findings + Mo
  // activity trace, one per folder. Created lazily on first patrol;
  // user-readable, MCP-readable for `morion-concierge` actor only
  // (other MCP actors get the existing per-folder permission gate).
  | 'mo:patrol-log'
  // Mo Indexing Redesign — per-theme aggregator notes (Phase 3).
  // N per folder, one per cluster id.
  | 'mo:cluster'
  // Mo Indexing Redesign — per-folder routing index (Phase 4).
  // Regular note with anchored sections (overview / clusters / recent
  // / risks). Maintained by Tier 2.5 after Tier 2 cluster regen.
  | 'mo:catalog'
  // Mo Indexing Redesign — LLM-synthesized cross-task risk prediction
  // (Phase 4). Currently merged into the catalog's `risks` section;
  // reserved as a separate source for future split-out.
  | 'mo:risks';

/**
 * Direction N — kanban column membership.
 *
 * `note` is the safe default: a reference/spec/idea on the shelf, NOT a
 * task in the execution queue. `backlog` is where executable work queues
 * up. Keeping the two distinct prevents brainstorm output from accidentally
 * filling an agent's worklist. Values are fixed — no custom statuses in
 * MVP (anti-feature).
 */
export const NOTE_STATUSES = ['note', 'backlog', 'todo', 'doing', 'review', 'done'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/**
 * Statuses that participate in manual drag-ordering inside a kanban column.
 * The `note` column sorts chronologically (updated_at desc), because
 * manual reorder in a 200-idea pile is pointless.
 */
export const MANUAL_ORDER_STATUSES: readonly NoteStatus[] = [
  'backlog',
  'todo',
  'doing',
  'review',
  'done',
];

export const FOLDER_VIEW_MODES = ['list', 'kanban'] as const;
export type FolderViewMode = (typeof FOLDER_VIEW_MODES)[number];

export interface Note {
  id: string;
  folderId: string | null;
  title: string;
  body: string;
  pinned: boolean;
  source: NoteSource;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /** Archived = hidden from default lists + MCP but reachable via the
   * UI "Show Archived" toggle. Distinct from trash (deleted_at): no
   * 7-day purge, user-initiated only, recoverable via Unarchive. */
  archivedAt: number | null;
  /** Kanban column membership. Always present; `note` in list-folders. */
  status: NoteStatus;
  /** Manual order inside a kanban column. Null in `note` column + list-folders. */
  position: number | null;
  /**
   * Per-ticket Auto-code workflow override. Either a built-in template
   * id (e.g. `"default"`, `"bug-fix"`) or the ULID of a `workflows`
   * row owned by the same folder. Null = "use folder default" (the
   * folder-level `auto_code.workflow_template.<folderId>` setting).
   * Ticket 01KRWQPDKQ2RZMDBJZ5KN0B7YE.
   */
  workflowId: string | null;
  tags: string[];
  /** Per-note MCP overrides. nulls mean "inherit from folder". */
  mcpPermissions: NoteMcpPermissions;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
  createdAt: number;
  /** `list` (default) or `kanban`. Decides how the folder renders in the UI. */
  viewMode: FolderViewMode;
  /** Archived flag — see Note.archivedAt. Archived folders + all their
   * notes stay in the DB but are hidden from default lists + MCP. */
  archivedAt: number | null;
  /** Number of non-deleted notes in this folder. Populated by `list()`. */
  noteCount: number;
  /** MCP access permissions. All-true by default — Free tier ignores these. */
  mcpPermissions: FolderMcpPermissions;
}

/** Booleans gating what MCP clients can do with a folder + its notes. */
export interface FolderMcpPermissions {
  visible: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
}

/** Per-note overrides. null = inherit from folder. There is no `create`
 * because notes can't contain notes. */
export interface NoteMcpPermissions {
  visible: boolean | null;
  update: boolean | null;
  delete: boolean | null;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  /** Number of non-deleted notes carrying this tag. Populated by `list()`. */
  noteCount: number;
}

// Zod schemas live alongside the types. Server-layer (HTTP, MCP) uses them to
// validate inputs at boundaries; core repositories trust their callers.

// Title is derived from the first line of body (Apple Notes parity).
// The optional `title` field exists for backwards compat with MCP clients
// that still pass it — the repo merges it into body and derives the cached
// title from the result.
// Direction N — status and position are accepted on create/update for
// backwards compat with MCP clients that know the kanban schema but not
// the dedicated tasks_* tools. The repository normalises them: `note` is
// forced when the folder is a list-folder (status is latent, not visible),
// and `null` position in a manual-order column is converted to top-of-column.
export const noteStatusSchema = z.enum(NOTE_STATUSES);

export const noteCreateSchema = z.object({
  title: z.string().max(500).optional(),
  body: z.string().default(''),
  folderId: z.string().nullish(),
  tags: z.array(z.string().min(1).max(64)).optional(),
  pinned: z.boolean().optional(),
  source: z.string().min(1),
  status: noteStatusSchema.optional(),
  position: z.number().nullish(),
});
export type NoteCreateInput = z.infer<typeof noteCreateSchema>;

export const noteUpdateSchema = z.object({
  title: z.string().max(500).optional(),
  body: z.string().optional(),
  folderId: z.string().nullish(),
  tags: z.array(z.string().min(1).max(64)).optional(),
  pinned: z.boolean().optional(),
  status: noteStatusSchema.optional(),
  position: z.number().nullish(),
  // Per-ticket Auto-code workflow override (ticket
  // 01KRWQPDKQ2RZMDBJZ5KN0B7YE). Either a built-in template id
  // (e.g. "default") or a `workflows` row ULID. null clears the
  // override so the ticket falls back to the folder-level default.
  // The repo writes the value as-is; resolver enforces folder
  // ownership / template existence at admission time.
  workflowId: z.string().nullish(),
});
export type NoteUpdateInput = z.infer<typeof noteUpdateSchema>;

export const noteListFiltersSchema = z.object({
  folderId: z.string().nullish(),
  tag: z.string().optional(),
  pinned: z.boolean().optional(),
  /** Default: hide archived notes + notes in archived folders. UI opts in
   * via the "Show Archived" toggle; MCP never opts in. */
  includeArchived: z.boolean().optional(),
  /** Phase 6.7 v2: by default exclude `mo:*` system notes (catalog,
   *  cluster, risks, patrol-log) — they're machine-readable indices
   *  surfaced through the Folder Settings dialog tabs, not user
   *  prose. Set true for debugging / power-user views. */
  includeMoSystem: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0),
});
export type NoteListFilters = z.infer<typeof noteListFiltersSchema>;

/**
 * Direction N — filter shape for `tasks_list`. Distinct from
 * `noteListFiltersSchema` because kanban read-intent is different:
 * always folder-scoped, column-aware, and `since/until` reuse
 * `updated_at` (we deliberately did NOT add a `due_date` column).
 */
export const tasksListFiltersSchema = z.object({
  folderId: z.string().min(1),
  status: noteStatusSchema.optional(),
  since: z.number().int().optional(),
  until: z.number().int().optional(),
  /** By default exclude `mo:*` system notes (catalog / cluster / risks /
   *  patrol-log) — they're machine-readable indices, not kanban cards, and
   *  on a Mo-indexed folder they otherwise flood `tasks_list` and drown the
   *  real tasks. Parallels `noteListFiltersSchema.includeMoSystem`. Set true
   *  only for debugging / power-user views. */
  includeMoSystem: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(200),
});
export type TasksListFilters = z.infer<typeof tasksListFiltersSchema>;
