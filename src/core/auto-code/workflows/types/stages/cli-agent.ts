import { z } from 'zod';

export const CliAgentNameSchema = z.enum(['claude', 'codex', 'pi', 'opencode']);
export type CliAgentName = z.infer<typeof CliAgentNameSchema>;

export const VerdictPolicySchema = z.object({
  /** Reopen target — when the parsed verdict is 'reopen', the runner
   *  re-runs the named stage with the reviewer's reason injected as
   *  `{{reopen.reason}}` into its prompt template. The named stage
   *  must appear earlier in the linear `stages[]` array. */
  onReopen: z
    .object({
      reopenStageId: z.string().min(1),
      /** Maximum total executions of `reopenStageId` (counting the
       *  initial run as attempt 1). When exceeded the runner fails
       *  the run with `lastError='reopen_cap_exhausted: ...'`. */
      maxAttempts: z.number().int().min(2).default(3),
    })
    .optional(),
  /** Behaviour when the parsed verdict is 'escalate'. Today the only
   *  policy is `'fail-run'`; L3 will add a `'paused_human_gate'`
   *  variant that opens an Ask Mo session for human triage. */
  onEscalate: z.enum(['fail-run']).default('fail-run'),
});
export type VerdictPolicy = z.infer<typeof VerdictPolicySchema>;

export const CliAgentStageSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('cli_agent'),
  /** Tool — which CLI agent binary to spawn. Per Editor Model v2 spec
   *  (Morion note 01KRAQWPXR5AYTFVF6J12TYHJ1) this is the "Tool" field
   *  on Agent stages. The Antigravity IDE is a future option pending an
   *  adapter — `src/core/auto-code/harness/adapters/` currently covers
   *  claude / codex / pi / opencode. */
  agent: CliAgentNameSchema,
  /** Provider — which API/auth path the underlying CLI uses to talk to
   *  the model. Examples: 'anthropic' (Claude direct), 'openai' (Codex
   *  direct / gpt-5 family), 'openrouter', 'groq', 'ollama'. NULL =
   *  adapter default (claude → OAuth Max; codex → ~/.codex/auth.json;
   *  pi → folder OpenRouter setting; opencode → folder default). The
   *  runner passes this as a CLI flag where the adapter supports it. */
  provider: z.string().nullable().default(null),
  /** Model — vendor model id like 'claude-opus-4-7', 'gpt-5', 'o4-mini',
   *  'anthropic/claude-opus-4-7' (OpenRouter id). NULL = adapter
   *  default. No hardcoded ship-time default per the broader Mo "no
   *  shipped model defaults" rule — vendor ids change monthly and
   *  shipping a default just guarantees it goes stale. */
  model: z.string().nullable().default(null),
  /** Level — quality/effort knob whose semantics depend on `agent`:
   *    - claude: 'Default' | 'Think' | 'ThinkHard' | 'ThinkHarder' | 'Ultrathink'
   *              (extended-thinking budgets — "think" idioms inlined into
   *              the prompt at dispatch time)
   *    - codex:  'Default' | 'Low' | 'Medium' | 'High'
   *              (Codex CLI `reasoning_effort` for o1/o3/o4/gpt-5 family)
   *    - pi / opencode: 'Default' only
   *  Editor renders an agent-discriminated dropdown; DB stores the string
   *  verbatim. NULL = adapter default. Mirrors MoModelOverrideSchema.level. */
  level: z.string().nullable().default(null),
  /** Free-text user-added instructions appended to the system prompt at
   *  dispatch time. Per spec: 'Прочитай claude.md и todo.md перед стартом',
   *  'use this skill', etc. Separate from `promptTemplate` which is the
   *  Mustache template over deterministic run context. Empty string =
   *  no extra instructions. */
  agentInstruction: z.string().default(''),
  /** Mustache template over deterministic run context (ticket title/body,
   *  folder name, prior stage outputs). No runtime expression language. */
  promptTemplate: z.string(),
  /** Optional per-stage budget cap. The runner refuses to spawn when the
   *  ticket's accumulated cost would exceed this. NULL = inherit folder cap. */
  maxBudgetUsd: z.number().nonnegative().nullable().default(null),
  /** Maximum attempts before the runner marks the stage `failed`. */
  maxAttempts: z.number().int().min(1).default(1),
  /** Allowed-tools list passed to the agent (claude `--allowedTools`, etc.). */
  allowedTools: z.array(z.string()).default([]),
  /** When the primary `agent` emits a recoverable terminal error
   *  (`ErrorEvent.recoverable === true` — codex 0.1.x Ink-mode crash
   *  is the canonical case), the runner re-spawns the SAME stage
   *  exactly once using this fallback agent before marking the stage
   *  failed. The retry counts against `maxAttempts`. Mirrors the
   *  legacy orchestrator's "codex Ink crash → claude-fallback"
   *  transparent-retry contract. */
  fallbackAgent: CliAgentNameSchema.optional(),
  /** Optional per-fallback overrides — same shape as the primary
   *  `provider` / `model` / `level` / `agentInstruction` fields but
   *  applied when the runner spawns `fallbackAgent`. NULL / empty
   *  on each field = inherit the adapter default for the fallback
   *  tool. These are non-default v2 Agent Status fields too — they
   *  route the workflow to draft-only mode via parseLinearWorkflow
   *  until Phase 4 plumbs them through to harness.spawn. */
  fallbackProvider: z.string().nullable().default(null),
  fallbackModel: z.string().nullable().default(null),
  fallbackLevel: z.string().nullable().default(null),
  fallbackAgentInstruction: z.string().default(''),
  /** When set, the runner parses the stage's terminal `summary` for a
   *  `{verdict, reason}` JSON envelope and routes the run accordingly:
   *    - 'approve'   → continue (default linear advance)
   *    - 'reopen'    → re-run `onReopen.reopenStageId` (if attempts < cap)
   *    - 'escalate'  → fail the run with the reviewer's reason
   *  Without `verdictPolicy` the stage's summary is just stored in
   *  `stages.<id>.output.summary` for the next stage's prompt. */
  verdictPolicy: VerdictPolicySchema.optional(),
});
export type CliAgentStage = z.infer<typeof CliAgentStageSchema>;
