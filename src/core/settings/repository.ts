import type Database from 'better-sqlite3';

/**
 * Tiny key/value store layered over the `settings` SQL table. Values are
 * JSON-encoded so we can hold booleans, numbers, strings, or small objects
 * without per-key migrations. Defaults live in the *getter*, not in the table:
 * a fresh DB has zero rows and `get(key, true)` returns `true` until the user
 * flips it. This makes "default-on" the natural state for the MCP gates.
 *
 * The repo is intentionally cache-free. The MCP gating wrapper hits this on
 * every tool call, but each call is one indexed PK lookup against an in-process
 * SQLite DB — measured at ~5 microseconds. A cache would just risk a stale
 * read after the user flips a toggle in another window.
 */

/**
 * Tool category — drives the "Read / Create / Update / Delete" toggles in the
 * settings UI. Every MCP tool is annotated with exactly one category at the
 * declaration site so adding a tool forces the author to pick a bucket.
 */
export type ToolCategory = 'read' | 'create' | 'update' | 'delete';

export const TOOL_CATEGORIES: ToolCategory[] = ['read', 'create', 'update', 'delete'];

/** Canonical key names — keep them in one place so the UI + backend agree. */
export const SETTINGS_KEYS = {
  mcpEnabled: 'mcp.enabled',
  mcpCategoryRead: 'mcp.category.read',
  mcpCategoryCreate: 'mcp.category.create',
  mcpCategoryUpdate: 'mcp.category.update',
  mcpCategoryDelete: 'mcp.category.delete',
  // Direction Q (0009): kill-switch for MCP edit/delete of comments.
  // Default true — MCP can edit/delete its own comments. User toggles
  // off in SettingsPanel when they want belt-and-braces lockdown.
  mcpCommentsEditable: 'mcp.comments.editable',
  // Direction Q Phase Q4: when true, tasks_move from an MCP actor
  // requires a non-empty `message` param — which auto-posts as a
  // comment on the note in the same transaction. User-initiated
  // kanban-move never enforces this.
  requireLlmStatusComment: 'mcp.require_status_comment',
  // First-run Terms & Privacy consent (ticket 01KPJF12ZJYZXJX2CQ7ACHZF60).
  // `termsAcceptedAt` is the unix-ms timestamp the user clicked Accept.
  // `termsVersion` is the Terms-of-Service publication date (ISO
  // `YYYY-MM-DD`) that they accepted at that moment. The app compares
  // the stored version against `CURRENT_TERMS_VERSION` from core/terms.ts
  // on launch and re-prompts on mismatch.
  termsAcceptedAt: 'terms.acceptedAt',
  termsVersion: 'terms.version',
} as const;

export interface McpSettings {
  enabled: boolean;
  categories: Record<ToolCategory, boolean>;
}

export class SettingsRepository {
  private readonly getStmt: Database.Statement;
  private readonly setStmt: Database.Statement;
  private readonly listStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    this.setStmt = db.prepare(
      'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.listStmt = db.prepare('SELECT key, value FROM settings');
  }

  /**
   * Read a setting, returning `defaultValue` if the row doesn't exist or the
   * stored JSON fails to parse. Parse failures are silently swallowed because
   * the only way to land bad JSON in the table is a manual sqlite3 edit, and
   * we'd rather degrade to defaults than crash the MCP child.
   */
  get<T>(key: string, defaultValue: T): T {
    const row = this.getStmt.get(key) as { value: string } | undefined;
    if (!row) return defaultValue;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return defaultValue;
    }
  }

  set<T>(key: string, value: T): void {
    this.setStmt.run(key, JSON.stringify(value));
  }

  /** Bulk read used by `GET /api/settings`. Returns parsed values. */
  getAll(): Record<string, unknown> {
    const rows = this.listStmt.all() as Array<{ key: string; value: string }>;
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        // Skip unparseable rows; same rationale as `get`.
      }
    }
    return out;
  }

  /** Typed view used by the gating wrapper + the settings UI. */
  getMcpSettings(): McpSettings {
    return {
      enabled: this.get<boolean>(SETTINGS_KEYS.mcpEnabled, true),
      categories: {
        read: this.get<boolean>(SETTINGS_KEYS.mcpCategoryRead, true),
        create: this.get<boolean>(SETTINGS_KEYS.mcpCategoryCreate, true),
        update: this.get<boolean>(SETTINGS_KEYS.mcpCategoryUpdate, true),
        delete: this.get<boolean>(SETTINGS_KEYS.mcpCategoryDelete, true),
      },
    };
  }

  setMcpEnabled(enabled: boolean): void {
    this.set(SETTINGS_KEYS.mcpEnabled, enabled);
  }

  setMcpCategory(category: ToolCategory, enabled: boolean): void {
    const key = {
      read: SETTINGS_KEYS.mcpCategoryRead,
      create: SETTINGS_KEYS.mcpCategoryCreate,
      update: SETTINGS_KEYS.mcpCategoryUpdate,
      delete: SETTINGS_KEYS.mcpCategoryDelete,
    }[category];
    this.set(key, enabled);
  }

  /**
   * Direction Q — MCP comments kill-switch. When false, MCP-origin calls
   * to `notes_update_comment` / `notes_delete_comment` return a disabled
   * error envelope without touching the DB. Default true (MCP may edit
   * its own comments via actor-match). UI actor='user' is never gated.
   */
  getMcpCommentsEditable(): boolean {
    return this.get<boolean>(SETTINGS_KEYS.mcpCommentsEditable, true);
  }

  setMcpCommentsEditable(enabled: boolean): void {
    this.set(SETTINGS_KEYS.mcpCommentsEditable, enabled);
  }

  /**
   * Direction Q Phase Q4 — when true, `tasks_move` from an MCP actor
   * requires a non-empty `message` param. User-initiated moves are
   * never required to comment. Default false (opt-in).
   */
  getRequireLlmStatusComment(): boolean {
    return this.get<boolean>(SETTINGS_KEYS.requireLlmStatusComment, false);
  }

  setRequireLlmStatusComment(enabled: boolean): void {
    this.set(SETTINGS_KEYS.requireLlmStatusComment, enabled);
  }

  /**
   * First-run Terms consent read. `acceptedAt` is null when the user
   * has not yet accepted; `version` is null in the same case. Both
   * populate in a single `acceptTerms(version)` call below so they
   * can't drift out of sync.
   */
  getTerms(): { acceptedAt: number | null; version: string | null } {
    return {
      acceptedAt: this.get<number | null>(SETTINGS_KEYS.termsAcceptedAt, null),
      version: this.get<string | null>(SETTINGS_KEYS.termsVersion, null),
    };
  }

  /**
   * Persist the user's consent. Writes both keys — there's no valid
   * state where one is set and the other isn't. Pass the exact
   * `CURRENT_TERMS_VERSION` the frontend showed to the user so the
   * record matches what they actually clicked on.
   */
  acceptTerms(version: string): void {
    this.set(SETTINGS_KEYS.termsAcceptedAt, Date.now());
    this.set(SETTINGS_KEYS.termsVersion, version);
  }
}
