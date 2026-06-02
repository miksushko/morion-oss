/**
 * Codex adapter — config parsing + env build + level mapping +
 * shared constants. Extracted from `../codex.ts` so the adapter
 * shell stays small.
 */

import {
  Codex,
  type Codex as CodexType,
  type CodexOptions,
  type ModelReasoningEffort,
  type ThreadOptions,
} from '@openai/codex-sdk';

import type { SpawnOptions } from '../../adapter.js';

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Factory signature for the Codex SDK. Test seam — pass a fake in
 *  tests; production uses `new Codex(opts)`. */
export type CodexFactory = (options: CodexOptions) => CodexType;

export const defaultCodexFactory: CodexFactory = (opts) => new Codex(opts);

/** Subset of `SpawnOptions.agentConfig` the Codex adapter understands.
 *  Other fields are ignored without complaint so the runner can pass a
 *  superset shared across adapters. */
export interface CodexAgentConfig {
  /** JSON schema describing the expected structured output. When set,
   *  the SDK enforces the schema and the agent's final message arrives
   *  as a JSON string in the schema's shape. Used by the Codex review
   *  stage so `parseVerdict` regex is bypassed entirely. */
  outputSchema?: unknown;
  /** Approval policy override. Defaults to `'never'` (SDK auto-approves
   *  reads/edits; no interactive prompts in our headless harness). */
  approvalPolicy?: ThreadOptions['approvalPolicy'];
  /** Sandbox mode override. Defaults to `'workspace-write'` so the
   *  agent can edit files in its worktree but not escape. */
  sandboxMode?: ThreadOptions['sandboxMode'];
  /** When true, the SDK skips its "is this a git repo?" guard. We set
   *  it by default because the harness manages worktrees externally;
   *  callers can set it false to opt back into the guard. */
  skipGitRepoCheck?: boolean;
}

export function parseAgentConfig(
  raw: SpawnOptions['agentConfig'],
): CodexAgentConfig {
  if (!raw || typeof raw !== 'object') return {};
  const out: CodexAgentConfig = {};
  if ('outputSchema' in raw) out.outputSchema = raw.outputSchema;
  if (
    'approvalPolicy' in raw &&
    typeof raw.approvalPolicy === 'string'
  ) {
    out.approvalPolicy = raw.approvalPolicy as ThreadOptions['approvalPolicy'];
  }
  if ('sandboxMode' in raw && typeof raw.sandboxMode === 'string') {
    out.sandboxMode = raw.sandboxMode as ThreadOptions['sandboxMode'];
  }
  if ('skipGitRepoCheck' in raw && typeof raw.skipGitRepoCheck === 'boolean') {
    out.skipGitRepoCheck = raw.skipGitRepoCheck;
  }
  return out;
}

/** Map Workflow Editor v2 `cli_agent.level` (Default/Low/Medium/High)
 *  to codex SDK's `modelReasoningEffort` value. Returns undefined for
 *  Default / unrecognised inputs so the SDK falls back to its own
 *  default. Exported for unit-test pin-down. */
export function mapCodexLevel(
  level: string | undefined,
): ModelReasoningEffort | undefined {
  if (!level) return undefined;
  const lower = level.toLowerCase();
  if (lower === 'minimal') return 'minimal';
  if (lower === 'low') return 'low';
  if (lower === 'medium') return 'medium';
  if (lower === 'high') return 'high';
  if (lower === 'xhigh') return 'xhigh';
  return undefined;
}

/** Build the env map passed to the SDK. Merges `process.env` with the
 *  caller-supplied env (caller wins), strips `MORION_HARNESS_*` keys
 *  (reserved for L1.T7 process-safety wrap), and drops undefined
 *  values which the SDK's TypeScript signature rejects. */
export function buildSdkEnv(
  callerEnv?: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  if (callerEnv) {
    for (const [k, v] of Object.entries(callerEnv)) {
      if (k.startsWith('MORION_HARNESS_')) continue;
      out[k] = v;
    }
  }
  return out;
}
