/**
 * Static description of a single LLM client we know how to install Morion
 * into. One adapter per client. Pure data — no side effects, no fs reads,
 * no env access at construction time. The installer in `installer.ts`
 * does all the IO using these.
 */
export interface ClientAdapter {
  /** Stable id used in URLs / CLI / settings storage. Kebab-case. */
  id: string;
  /** Human-friendly name shown in the UI. */
  displayName: string;
  /**
   * Absolute path to the JSON config file. Lazy because some clients use
   * `$HOME` and we don't want to capture it at module load.
   */
  configPath(): string;
  /**
   * The key under `mcpServers` (or another root-level container — see
   * `containerKey`) that identifies our entry. Always `"morion"`.
   * Centralised so we never typo it across adapters.
   */
  serverKey: string;
  /**
   * Root-level key in the config file that holds the map of MCP servers.
   * Most clients use `mcpServers`. Zed uses `context_servers`. Defaults
   * to `mcpServers` when unset.
   */
  containerKey?: string;
  /**
   * Optional detector. When present, the UI grays out the Connect button
   * and shows "(not installed)" if it returns false. Without a detector,
   * the adapter is assumed installed (fail-open) — preserves the v0.97.0
   * behaviour for legacy callers.
   */
  isInstalled?: ClientDetector;
}

/** Best-effort detection: is this client actually installed on the user's
 * machine? Returns true if a characteristic dir/file exists — every
 * supported client creates a config/cache dir on first launch, so absence
 * = client never run = not installed.
 *
 * Optional: legacy adapters without a detector return true (fail-open).
 */
export type ClientDetector = () => boolean;

/** Per-client install status. */
export type ClientStatus =
  /** Config file doesn't exist yet — install would create it. */
  | { kind: 'not-installed'; reason: 'no-config-file' }
  /** File exists, JSON is valid, but no `morion` entry. */
  | { kind: 'not-installed'; reason: 'no-entry' }
  /** Morion entry present and matches the current launcher path. */
  | { kind: 'installed-current'; entry: McpServerEntry }
  /** Morion entry present but points at a different command/args. */
  | { kind: 'installed-stale'; entry: McpServerEntry }
  /** File exists but is not valid JSON — installer refuses to touch it. */
  | { kind: 'config-malformed'; error: string };

/** Shape we write into `mcpServers.morion`. Mirrors what every client expects. */
export interface McpServerEntry {
  command: string;
  args: string[];
}

/** Result of an install or uninstall call. */
export interface MutationResult {
  ok: true;
  /** Path to the timestamped backup we wrote before touching the file, if any. */
  backupPath: string | null;
  /** Final config file path. */
  configPath: string;
}
