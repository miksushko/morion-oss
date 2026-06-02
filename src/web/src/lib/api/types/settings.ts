/**
 * Settings domain types — workspace MCP settings, comments,
 * terms-of-service, runtime info, MCP-client install surfaces,
 * audit entries.
 */

export type ToolCategory = 'read' | 'create' | 'update' | 'delete';

export interface McpCategoryGates {
  read: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
}

export interface McpSettings {
  enabled: boolean;
  categories: McpCategoryGates;
}

export interface ToolSummary {
  name: string;
  description: string;
}

/** Direction Q — comments-related toggles exposed alongside MCP settings. */
export interface CommentsSettings {
  /** When false, MCP actors cannot edit/delete their own comments. */
  mcpCommentsEditable: boolean;
  /** When true, tasks_move from MCP actors requires a non-empty `message`
   *  param and auto-posts it as a comment. User moves never enforce. */
  requireLlmStatusComment: boolean;
}

export interface TermsInfo {
  /** Current ToS publication date (ISO `YYYY-MM-DD`). Shipped with the build. */
  current: string;
  /** Unix-ms when the user clicked Accept, or null if they haven't. */
  acceptedAt: number | null;
  /** Version the user accepted. Null alongside `acceptedAt`. Compared
   *  lexicographically against `current` — lower value means a re-consent
   *  prompt should be shown. */
  acceptedVersion: string | null;
}

export interface SettingsResponse {
  mcp: McpSettings;
  toolsByCategory: Record<ToolCategory, ToolSummary[]>;
  comments: CommentsSettings;
  terms: TermsInfo;
}

export interface RuntimeInfo {
  execPath: string;
  scriptPath: string | null;
  isBundled: boolean;
  launcherPath: string | null;
  /** Node's `process.platform` value: `darwin` | `win32` | `linux`. */
  platform: string;
  /** Node's `process.arch` value: `arm64` | `x64` | etc. Added v1.2+ for the Windows port. */
  arch: string;
  cwd: string;
}

export type ClientStatus =
  | { kind: 'not-installed'; reason: 'no-config-file' | 'no-entry' }

export interface InstallableClient {
  id: string;
  displayName: string;
  configPath?: string;
  status?: ClientStatus;
  /** True when the client appears installed (its config dir exists).
   * Server returns true also for adapters without a detector. UI
   * disables Connect when this is false. */
  installed?: boolean;
}

export interface InstallClientsResponse {
  bundled: boolean;
  message?: string;
  launcherPath?: string;
  clients: InstallableClient[];
}

export interface InstallMutationResult {
  ok: true;
  backupPath: string | null;
  configPath: string;
}

export interface AuditEntry {
  id: number;
  noteId: string | null;
  noteTitle: string | null;
  action:
    | 'create'
    | 'update'
    | 'delete'
    | 'read'
    | 'status_change'
    | 'comment_delete'
    | 'archive'
    | 'unarchive';
  actor: string;
  timestamp: number;
  /** Populated only on `status_change` rows. Lets the UI render
   * "Moved A → B" instead of just "Status changed". */
  statusFrom?: string | null;
  statusTo?: string | null;
}
