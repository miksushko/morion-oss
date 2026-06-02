/**
 * Auto-code CLI Agent Harness — `codex` adapter, SDK edition.
 *
 * As of ticket 01KRJNFGC1AB0FD81WYMGPMHHH (2026-05-16) this adapter
 * runs on `@openai/codex-sdk` instead of spawning the `codex` CLI by
 * hand. The SDK still shells the Rust binary under the hood — same
 * sandbox, same `apply_patch`, same `~/.codex/auth.json` ChatGPT-OAuth
 * — but it owns the JSONL event protocol, child lifecycle, and
 * AbortSignal-based cancel so we can drop several brittle parsing
 * layers we maintained against codex 0.1.x:
 *
 *   - No more `stdoutLooksUnhealthy` Ink-crash detector. The SDK shells
 *     the Rust binary directly; the Node-Ink TTY path never runs.
 *   - No more `--approval-mode suggest --no-project-doc -q` argv
 *     juggling. `Codex.startThread()` + `ThreadOptions.approvalPolicy`
 *     express the same intent.
 *   - No more `parseVerdict` regex tower for Codex review. Callers can
 *     hand a JSON schema via `agentConfig.outputSchema` and the SDK
 *     returns the parsed JSON as the `agent_message` text — workflow
 *     runner reads `terminal.summary` as JSON without regex. (The
 *     shared `workflows/verdict.ts` regex stays for Claude / Pi /
 *     Opencode, which have no equivalent.)
 *   - **Session resume is real now.** `SpawnOptions.resumeSessionId` →
 *     `Codex.resumeThread(id)`; the workflow runner's Phase 6 V2
 *     fallback-to-fresh-spawn is no longer needed for Codex (still
 *     fine if it fires).
 *
 * Public adapter contract preserved verbatim:
 *
 *   - `spawn(opts) → AgentHandle` resolves once the SDK's first event
 *     (`thread.started`) arrives, so `handle.sessionId` reflects the
 *     real SDK thread_id from the moment `spawn()` returns.
 *   - `handle.events` is an `AsyncIterable<CliAgentEvent>` mirroring
 *     the unified harness taxonomy.
 *   - `handle.cancel(reason)` aborts the SDK AbortSignal — SDK SIGTERMs
 *     the underlying Rust process. Idempotent.
 *   - `handle.resume(injectedMessage)` returns a fresh handle for the
 *     same thread via `Codex.resumeThread()`. No longer throws
 *     `AgentResumeUnsupportedError` for Codex.
 *   - `handle.getCost()` returns 0 — SDK doesn't surface per-call cost
 *     any more than the CLI did. Token counts are available via
 *     `turn.completed.usage` but we don't translate them to USD here.
 *
 * `handle.pid` is `null` for SDK-driven runs: the SDK owns the child
 * process and does not surface its OS PID. Worktree-lock / registry
 * protections from the subprocess path are NOT engaged (lock would
 * race with the SDK's own child anyway). The SDK's own SIGTERM chain +
 * our AbortController are the defence in depth.
 *
 * Module layout — kept under the 500-LOC cap per CLAUDE.md:
 *   - `./codex/agent-config.ts` — config parse + env build + level map
 *   - `./codex/event-mappers.ts` — SDK ThreadItem → CliAgentEvent
 *   - `./codex/handle.ts` — CodexSdkAgentHandle (state-machine class)
 *   - this file — adapter spawn wiring + public re-exports
 */

import { existsSync } from 'node:fs';

import type { ThreadOptions } from '@openai/codex-sdk';

import {
  AgentSpawnError,
  type AgentHandle,
  type CliAgentAdapter,
  type SpawnOptions,
} from '../adapter.js';
import type { AgentName } from '../events.js';
import { generateSessionId, resolveAgentBinary } from '../util.js';
import {
  DEFAULT_TIMEOUT_MS,
  buildSdkEnv,
  defaultCodexFactory,
  mapCodexLevel,
  parseAgentConfig,
  type CodexFactory,
} from './codex/agent-config.js';
import { CodexSdkAgentHandle } from './codex/handle.js';

// Re-export public surface so existing importers
// (`from '.../adapters/codex.js'`) continue to work unchanged.
export { mapCodexLevel } from './codex/agent-config.js';
export type {
  CodexAgentConfig,
  CodexFactory,
} from './codex/agent-config.js';

export interface CodexAdapterOptions {
  /** Override the resolved `codex` binary the SDK will spawn. When
   *  omitted, the adapter resolves via `MORION_CODEX_BIN`, then
   *  `which codex` on PATH. The path is passed to the SDK as
   *  `CodexOptions.codexPathOverride`. */
  binPath?: string;
  /** Test seam — inject a fake SDK factory. Production callers leave
   *  this undefined so the real `Codex` constructor is used. */
  codexFactory?: CodexFactory;
}

export class CodexAdapter implements CliAgentAdapter {
  readonly name: AgentName = 'codex';

  constructor(private readonly options: CodexAdapterOptions = {}) {}

  async spawn(opts: SpawnOptions): Promise<AgentHandle> {
    const binPath = await this._resolveBinPath();
    const factory = this.options.codexFactory ?? defaultCodexFactory;
    const agentConfig = parseAgentConfig(opts.agentConfig);

    // SDK options that scope every Thread the Codex instance opens.
    // `env` overrides `process.env` inheritance per SDK contract, so
    // we merge process.env + caller env so MORION_API_TOKEN / OPENAI_API_KEY
    // / whatever the user has set survives. `MORION_HARNESS_*` keys are
    // stripped because they're reserved for the L1.T7 safety wrap.
    const sdkEnv = buildSdkEnv(opts.env);
    const codex = factory({
      codexPathOverride: binPath,
      env: sdkEnv,
    });

    const threadOptions: ThreadOptions = {
      workingDirectory: opts.cwd,
      // Harness owns the worktree, not git. Default to skipping so a
      // non-git cwd (tests, ad-hoc dirs) doesn't fail.
      skipGitRepoCheck: agentConfig.skipGitRepoCheck ?? true,
      // Headless harness — no interactive approval prompt possible.
      approvalPolicy: agentConfig.approvalPolicy ?? 'never',
      sandboxMode: agentConfig.sandboxMode ?? 'workspace-write',
    };
    if (opts.model) threadOptions.model = opts.model;
    const effort = mapCodexLevel(opts.level);
    if (effort) threadOptions.modelReasoningEffort = effort;

    const thread = opts.resumeSessionId
      ? codex.resumeThread(opts.resumeSessionId, threadOptions)
      : codex.startThread(threadOptions);

    return CodexSdkAgentHandle._start({
      codex,
      thread,
      binPath,
      // Caller-supplied id is informational only — the SDK owns thread
      // identity. We surface it before `thread.started` arrives so the
      // transcript file name is deterministic; after `thread.started`
      // we switch `handle.sessionId` to the SDK's thread_id so
      // subsequent `resumeSessionId` calls round-trip correctly.
      provisionalSessionId: opts.sessionId ?? generateSessionId(),
      agent: 'codex',
      prompt: opts.prompt,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: opts.signal,
      transcriptDir: opts.transcriptDir,
      outputSchema: agentConfig.outputSchema,
      isResume: opts.resumeSessionId != null,
    });
  }

  private async _resolveBinPath(): Promise<string> {
    if (this.options.binPath) {
      if (!existsSync(this.options.binPath)) {
        throw new AgentSpawnError(
          `codex binPath does not exist: ${this.options.binPath}`,
        );
      }
      return this.options.binPath;
    }
    return resolveAgentBinary('codex', 'codex');
  }
}
