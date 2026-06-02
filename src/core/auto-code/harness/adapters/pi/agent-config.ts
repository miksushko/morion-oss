import type { SpawnOptions } from '../../adapter.js';
import type { AbstractHandleParams } from '../../abstract-handle-types.js';

/**
 * Pi adapter config — option types + agentConfig narrow + tool-name
 * mapping. Extracted from adapters/pi.ts during the 2026-05-16 split
 * (Morion ticket 01KRQYSGYJM48WC1NJTTHZ9XNE). Mirrors the codex/
 * subdir layout shipped under ticket 01KRJNFGC1AB0FD81WYMGPMHHH.
 */

export interface PiAdapterOptions {
  /** Override binary path. Resolution order: this option →
   *  `MORION_PI_BIN` env var → `which pi` on PATH. */
  binPath?: string;
}

/** Per-spawn config narrowed from `SpawnOptions.agentConfig`. */
export interface PiAgentConfig {
  /** Pi provider name (e.g. `ollama`, `openai`, `openrouter`).
   *  Forwarded as `--provider <value>`. Omit to use pi's default. */
  provider?: string;
  /** Required pi packages for this run. The L1 v1 implementation
   *  records the field but does NOT enforce — pre-flight check
   *  lands in L4 onboarding alongside an install-hint UX. */
  requiredPackages?: readonly string[];
}

export function parseAgentConfig(
  raw: SpawnOptions['agentConfig'],
): PiAgentConfig {
  if (!raw || typeof raw !== 'object') return {};
  const out: PiAgentConfig = {};
  if (typeof raw.provider === 'string') out.provider = raw.provider;
  if (Array.isArray(raw.requiredPackages)) {
    const arr = raw.requiredPackages.filter(
      (v): v is string => typeof v === 'string',
    );
    if (arr.length > 0) out.requiredPackages = arr;
  }
  return out;
}

// ---------------------------------------------------------------------
// Tool-name mapping: claude-style → pi-style
// ---------------------------------------------------------------------

/** Pi uses lowercase short names; we use claude-style canonical
 *  names in `SpawnOptions.allowedTools`. Map at the adapter
 *  boundary so callers stay vendor-agnostic. */
export const CLAUDE_TO_PI_TOOL_MAP: Readonly<Record<string, string>> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Glob: 'find',
  Grep: 'grep',
  Bash: 'bash',
};

export const DEFAULT_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
];

export function mapToolNames(claudeNames: readonly string[]): string {
  return claudeNames
    .map((name) => CLAUDE_TO_PI_TOOL_MAP[name] ?? name.toLowerCase())
    .join(',');
}

// ---------------------------------------------------------------------
// Handle params shape
// ---------------------------------------------------------------------

export interface PiHandleParams extends AbstractHandleParams {
  mode: 'fresh' | 'resume';
  allowedTools?: readonly string[];
  model?: string;
  provider?: string;
  requiredPackages?: readonly string[];
}
