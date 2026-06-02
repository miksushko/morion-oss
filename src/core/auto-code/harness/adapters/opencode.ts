/**
 * Auto-code CLI Agent Harness — `opencode` adapter (L1.T6).
 *
 * Spawns the [opencode](https://github.com/opencode-ai/opencode) CLI
 * (95k★ Go-based agent) and translates its `--format json` event
 * stream into the unified `CliAgentEvent` stream.
 *
 * CLI invocation:
 *
 *     opencode run "<prompt>" \
 *       --format json \
 *       [--session <id>] \                # for resume
 *       --dangerously-skip-permissions    # headless mode
 *
 * **Schema caveats (real-CLI smoke pending in L1.T10):**
 *
 * Opencode's official docs describe `--format json` as "raw JSON events"
 * but don't enumerate the discriminator values the way pi-mono does. The
 * adapter:
 *
 *   1. Treats output as **streaming NDJSON** (one JSON event per line).
 *   2. Maps the production event taxonomy (`step_start`, `tool_use`,
 *      `text`, `step_finish`, `error`) — see `./opencode/event-mappers.ts`.
 *   3. Falls back gracefully — if NO terminal event arrives in stream
 *      but exit code is 0, surface result with stdout summary. Non-zero
 *      → error{non_zero_exit}.
 *
 * **No granular tool allowlist.** Opencode's `run` command lacks the
 * `--allowedTools` flag (claude/pi style); permissions are configured
 * via `opencode agent create`. The adapter:
 *   - Always passes `--dangerously-skip-permissions` for headless
 *   - Silently ignores `SpawnOptions.allowedTools`
 *
 * **Cost = 0** (informational). Like pi, opencode surfaces cost via
 * `step_finish.part.cost` cumulative — but only on the terminal `stop`
 * step (other reasons are intermediate). See `./opencode/event-mappers.ts`.
 *
 * **Resume.** `--session <id>` continues an existing session.
 * Adapter captures opencode's authoritative session id from the first
 * `step_start` event.
 *
 * Module layout — per the 2026-05-16 split (Morion ticket
 * `01KRQYRA9...`, mirror of the codex precedent):
 *   - `./opencode/agent-config.ts` — option types + handle params shape.
 *   - `./opencode/event-mappers.ts` — pure `mapOpencodeEventToHarness`.
 *   - `./opencode/handle.ts`       — `OpencodeAgentHandle` state machine.
 *   - this file                    — `OpencodeAdapter` spawn wiring + public re-exports.
 */

import { existsSync } from 'node:fs';

import {
  AgentSpawnError,
  type AgentHandle,
  type CliAgentAdapter,
  type SpawnOptions,
} from '../adapter.js';
import { DEFAULT_TIMEOUT_MS } from '../abstract-handle-types.js';
import type { AgentName } from '../events.js';
import { generateSessionId, resolveAgentBinary } from '../util.js';
import type { OpencodeAdapterOptions } from './opencode/agent-config.js';
import { OpencodeAgentHandle } from './opencode/handle.js';

// Re-export public surface so existing importers
// (`from '.../adapters/opencode.js'`) keep working unchanged.
export { mapOpencodeEventToHarness } from './opencode/event-mappers.js';
export type { OpencodeAdapterOptions } from './opencode/agent-config.js';

export class OpencodeAdapter implements CliAgentAdapter {
  readonly name: AgentName = 'opencode';

  constructor(private readonly options: OpencodeAdapterOptions = {}) {}

  async spawn(opts: SpawnOptions): Promise<AgentHandle> {
    const binPath = await this._resolveBinPath();
    // Phase 6 V2 hotfix (2026-05-13) — when caller supplies
    // `resumeSessionId`, spawn in resume mode against that prior
    // opencode-authoritative session id.
    const resumeId = opts.resumeSessionId;
    return OpencodeAgentHandle._start({
      binPath,
      sessionId: resumeId ?? opts.sessionId ?? generateSessionId(),
      agent: 'opencode',
      mode: resumeId ? 'resume' : 'fresh',
      prompt: opts.prompt,
      cwd: opts.cwd,
      model: opts.model,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: opts.env,
      signal: opts.signal,
      transcriptDir: opts.transcriptDir,
      // Note: opts.allowedTools intentionally NOT forwarded — opencode
      // run command has no granular allowlist (see header).
      // Note: opts.maxBudgetUsd intentionally NOT forwarded — opencode
      // doesn't expose a per-call budget cap flag.
    });
  }

  private async _resolveBinPath(): Promise<string> {
    if (this.options.binPath) {
      if (!existsSync(this.options.binPath)) {
        throw new AgentSpawnError(
          `opencode binPath does not exist: ${this.options.binPath}`,
        );
      }
      return this.options.binPath;
    }
    return resolveAgentBinary('opencode', 'opencode');
  }
}
